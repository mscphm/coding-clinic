/*!
 * NUS Coding Clinic - mock-data.js
 * A complete in-browser implementation of the API contract (SPEC.md §5) so the
 * whole site can be demonstrated with MOCK:true and no backend at all.
 *
 *   Clinic.mock.handle(action, data, token) -> Promise   (~80 ms fake latency)
 *   Clinic.mock.reset()                                  wipe + reseed + reload
 *   Clinic.mock.switchUser('student'|'instructor')       swap the signed-in persona
 *   Clinic.mock.signOut()                                drop the current session
 *   Clinic.mock.personas()                               [{key, user_id, display_name, email, role}]
 *   Clinic.mock.hint()                                   one-line sign-in hint for login.html
 *   Clinic.mock.state()                                  the raw seeded tables (debugging)
 *
 * This file must not touch Clinic.api - it loads before it. All state is built
 * lazily on the first handle() call and persisted to localStorage.
 *
 * Everything dated is computed from the real clock at seed time, so the clinic is
 * always "this coming Thursday" and posts are always "2 days ago". When the clinic
 * date rolls past, the seed is rebuilt automatically (see anchorFor / init).
 */
(function (window) {
  'use strict';

  window.Clinic = window.Clinic || {};
  var Clinic = window.Clinic;

  var STATE_KEY = 'clinic_mock_state';
  var STATE_VERSION = 1;
  var LATENCY_MS = 80;
  var SGT_MS = 8 * 3600 * 1000;              /* Asia/Singapore, UTC+8, no DST */
  var DAY_MS = 86400000;

  var DOW = {
    Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
    Thursday: 4, Friday: 5, Saturday: 6
  };

  /* ================================================================ storage */

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function readJSON(k) {
    var raw = lsGet(k);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /* ================================================================== utils */

  function L() { return Array.prototype.join.call(arguments, '\n'); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function find(list, key, value) {
    for (var i = 0; i < list.length; i++) if (list[i][key] === value) return list[i];
    return null;
  }
  function where(list, fn) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (fn(list[i], i)) out.push(list[i]);
    return out;
  }
  function countWhere(list, fn) {
    var n = 0;
    for (var i = 0; i < list.length; i++) if (fn(list[i])) n++;
    return n;
  }
  function removeWhere(list, fn) {
    for (var i = list.length - 1; i >= 0; i--) if (fn(list[i])) list.splice(i, 1);
  }

  var idSeq = 0;
  function nid(prefix) {
    idSeq += 1;
    return prefix + '_' + Date.now().toString(36) + idSeq.toString(36);
  }

  function str(v) { return (v === null || v === undefined) ? '' : String(v); }
  function trimmed(v) { return str(v).replace(/^\s+|\s+$/g, ''); }

  function fail(code, message) {
    throw { code: code, message: message };
  }

  /* ============================================================ time (SGT) */

  function sgt(d) { return new Date(d.getTime() + SGT_MS); }
  function nowMs() { return Date.now(); }
  function isoAt(ms) { return new Date(ms).toISOString(); }
  function isoAgo(ms) { return isoAt(nowMs() - ms); }
  function hoursAgo(h) { return isoAgo(h * 3600000); }
  function daysAgo(d) { return isoAgo(d * DAY_MS); }

  function sgtDateStr(d) {
    var s = sgt(d);
    return s.getUTCFullYear() + '-' + pad2(s.getUTCMonth() + 1) + '-' + pad2(s.getUTCDate());
  }
  function dateStrDow(dateStr) {
    var p = dateStr.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
  }
  function addDaysStr(dateStr, n) {
    var p = dateStr.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + n * DAY_MS);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  /* SGT wall-clock (date + HH:MM) -> ISO 8601 UTC, the format every table uses. */
  function isoFromSgt(dateStr, timeStr) {
    var dp = dateStr.split('-');
    var tp = str(timeStr || '00:00').split(':');
    return isoAt(Date.UTC(+dp[0], +dp[1] - 1, +dp[2], +tp[0] || 0, +tp[1] || 0, 0) - SGT_MS);
  }
  function toMin(hhmm) {
    var p = str(hhmm).split(':');
    return (+p[0] || 0) * 60 + (+p[1] || 0);
  }
  function fromMin(m) { return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); }

  function monthStartMs() {
    var s = sgt(new Date());
    return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1, 0, 0, 0) - SGT_MS;
  }
  function todayStartMs() {
    return Date.parse(isoFromSgt(sgtDateStr(new Date()), '00:00'));
  }

  /* The next cutoff instant strictly in the future. */
  function nextCutoffIso(cfgObj) {
    var dayName = cfgObj.booking_cutoff_day || 'Wednesday';
    var timeStr = cfgObj.booking_cutoff_time || '23:59';
    var target = DOW[dayName];
    if (target === undefined) target = 3;
    var today = sgtDateStr(new Date());
    var delta = (target - dateStrDow(today) + 7) % 7;
    var iso = isoFromSgt(addDaysStr(today, delta), timeStr);
    if (Date.parse(iso) <= nowMs()) iso = isoFromSgt(addDaysStr(today, delta + 7), timeStr);
    return iso;
  }

  /* The clinic date that the next cutoff governs (Wed cutoff -> Thu clinic). */
  function nextClinicDate(cfgObj) {
    var cutoffIso = nextCutoffIso(cfgObj);
    var cutoffDate = sgtDateStr(new Date(Date.parse(cutoffIso)));
    var clinicDow = DOW[cfgObj.clinic_day];
    if (clinicDow === undefined) clinicDow = 4;
    var delta = (clinicDow - dateStrDow(cutoffDate) + 7) % 7;
    if (delta === 0) delta = 7;
    return addDaysStr(cutoffDate, delta);
  }

  /* The cutoff that applies to a particular clinic date: the most recent
     cutoff-day at cutoff-time strictly before it. */
  function cutoffForDate(cfgObj, dateStr) {
    var target = DOW[cfgObj.booking_cutoff_day];
    if (target === undefined) target = 3;
    for (var i = 1; i <= 7; i++) {
      var candidate = addDaysStr(dateStr, -i);
      if (dateStrDow(candidate) === target) {
        return isoFromSgt(candidate, cfgObj.booking_cutoff_time || '23:59');
      }
    }
    return isoFromSgt(addDaysStr(dateStr, -1), cfgObj.booking_cutoff_time || '23:59');
  }

  function slotStartTimes(cfgObj) {
    var step = parseInt(cfgObj.slot_minutes, 10) || 20;
    var start = toMin(cfgObj.clinic_start || '13:00');
    var end = toMin(cfgObj.clinic_end || '16:00');
    var out = [];
    for (var t = start; t + step <= end; t += step) out.push(fromMin(t));
    return out;
  }

  /* ================================================================= config */

  function seedConfig() {
    return {
      site_title: 'NUS Coding Clinic',
      allowed_domains: 'u.nus.edu,nus.edu.sg',
      admin_emails: 'xavierchee@gmail.com',
      passcode_mode: 'FALSE',
      class_passcode: '',
      categories: 'Environment & setup,Syntax & errors,Concepts,Debugging,' +
        'Data wrangling,Stats & interpretation,Assignments,General',
      labels: 'python-basics,pandas,plotting,statistics,environment,assignment',
      clinic_day: 'Thursday',
      clinic_start: '13:00',
      clinic_end: '16:00',
      slot_minutes: '20',
      booking_cutoff_day: 'Wednesday',
      booking_cutoff_time: '23:59',
      max_active_bookings: '1',
      notice_text: 'Welcome! Post concepts, errors and debugging questions freely ' +
        '\u2014 do not post assignment solution code. Questions are answered within ' +
        '1 working day. Book a clinic slot only after posting a thread about your issue.',
      code_ttl_minutes: '10',
      session_days: '30'
    };
  }

  function csvList(value) {
    return str(value).split(',').map(trimmed).filter(function (s) { return !!s; });
  }
  function isTrue(value) { return str(value).toUpperCase() === 'TRUE'; }

  function adminEmails(cfgObj) {
    return csvList(cfgObj.admin_emails).map(function (e) { return e.toLowerCase(); });
  }
  function roleForEmail(cfgObj, email) {
    return adminEmails(cfgObj).indexOf(str(email).toLowerCase()) !== -1 ? 'instructor' : 'student';
  }

  /* ============================================================ seed content */

  function seedUsers() {
    return [
      { user_id: 'u_you', email: 'you@u.nus.edu', display_name: 'you', role: 'student', created_at: daysAgo(40), last_login: hoursAgo(2) },
      { user_id: 'u_ins', email: 'xavierchee@gmail.com', display_name: 'Dr Chee', role: 'instructor', created_at: daysAgo(60), last_login: hoursAgo(4) },
      { user_id: 'u_ana', email: 'ana@u.nus.edu', display_name: 'sgcoder', role: 'student', created_at: daysAgo(39), last_login: hoursAgo(9) },
      { user_id: 'u_ben', email: 'ben@u.nus.edu', display_name: 'pandas_fan', role: 'student', created_at: daysAgo(39), last_login: hoursAgo(30) },
      /* Three quieter classmates. They read and vote but rarely post - they exist
         so upvote counts and the leaderboard look like a real cohort. */
      { user_id: 'u_kai', email: 'kai@u.nus.edu', display_name: 'kaitlyn_t', role: 'student', created_at: daysAgo(38), last_login: daysAgo(1) },
      { user_id: 'u_raj', email: 'raj@u.nus.edu', display_name: 'raj_m', role: 'student', created_at: daysAgo(38), last_login: daysAgo(2) },
      { user_id: 'u_min', email: 'minhui@u.nus.edu', display_name: 'minhui', role: 'student', created_at: daysAgo(35), last_login: daysAgo(3) }
    ];
  }

  function seedThreads() {
    return [
      {
        thread_id: 't_welcome',
        title: 'Read first: how this clinic works',
        category: 'General',
        labels: [],
        author_id: 'u_ins',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: true,
        deleted: false,
        created_at: daysAgo(38),
        body_md: L(
          'Welcome to the coding clinic. There are two ways to get help, and you are',
          'meant to use both.',
          '',
          '**1. Post here.** Anything about Python, pandas, plotting or stats. I read the',
          'board every working day and answer within one working day.',
          '',
          '**2. Book a 20-minute slot.** Thursdays, 13:00-16:00. Post a thread about your',
          'problem *first*, then book from **Clinic booking** and link the thread. That is',
          'not bureaucracy - half the time writing the thread solves it, and when it does',
          'not, I arrive already knowing what broke.',
          '',
          '### How to ask so you get a useful answer',
          '',
          '- One line on what you were trying to do.',
          '- The **exact** error, all of it, in a fenced code block:',
          '',
          '```python',
          'Traceback (most recent call last):',
          '  File "analysis.py", line 12, in <module>',
          '    df["Age"].mean()',
          'KeyError: "Age"',
          '```',
          '',
          '- The smallest piece of code that reproduces it.',
          '- What you already tried.',
          '',
          'Screenshots of code are hard to read and impossible to copy. Paste text.',
          '',
          '### Ground rules',
          '',
          '| Fine | Not fine |',
          '| --- | --- |',
          '| Concepts, errors, debugging, "why does this work" | Posting your assignment solution |',
          '| Sharing a 5-line snippet that reproduces a bug | Asking someone to write Q3 for you |',
          '| Answering a classmate | Answering with a full solution before the deadline |',
          '',
          'Tick **Post anonymously** if you would rather not attach your name to a question.',
          'Classmates only see "Anonymous". Nobody has ever been judged for asking here, but',
          'if it lowers the barrier, use it.'
        )
      },
      {
        thread_id: 't_conda',
        title: 'conda activate does nothing after installing Miniconda on Windows',
        category: 'Environment & setup',
        labels: ['environment'],
        author_id: 'u_ana',
        is_anonymous: false,
        status: 'answered',
        accepted_post_id: 'p_conda_1',
        resolved_via: 'async',
        pinned: false,
        deleted: false,
        created_at: daysAgo(31),
        body_md: L(
          'Fresh Miniconda install on Windows 11. Building the course environment worked:',
          '',
          '```bash',
          'conda env create -f phm5003.yml',
          '```',
          '',
          'But in PowerShell, `conda activate phm5003` just returns me to the prompt with no',
          '`(phm5003)` prefix, and then:',
          '',
          '```bash',
          'python -c "import pandas"',
          '# ModuleNotFoundError: No module named \'pandas\'',
          '```',
          '',
          '`conda info --envs` does list the environment, so it exists. Anaconda Prompt works',
          'fine - it is only PowerShell that ignores me. What am I missing?'
        )
      },
      {
        thread_id: 't_keyerror',
        title: 'KeyError: "Age" when the column is clearly in the CSV',
        category: 'Debugging',
        labels: ['pandas'],
        author_id: 'u_you',
        is_anonymous: false,
        status: 'answered',
        accepted_post_id: 'p_key_1',
        resolved_via: 'async',
        pinned: false,
        deleted: false,
        created_at: daysAgo(17),
        body_md: L(
          'Loading the class survey export and immediately hitting a KeyError, even though',
          '`Age` is right there in the header row when I open the file in Excel.',
          '',
          '```python',
          'import pandas as pd',
          '',
          'df = pd.read_csv("survey_export.csv")',
          'print(df["Age"].mean())',
          '```',
          '',
          '```python',
          'Traceback (most recent call last):',
          '  File "C:\\Users\\me\\phm5003\\clean.py", line 4, in <module>',
          '    print(df["Age"].mean())',
          '  File "...\\pandas\\core\\frame.py", line 4102, in __getitem__',
          '    indexer = self.columns.get_loc(key)',
          '  File "...\\pandas\\core\\indexes\\base.py", line 3812, in get_loc',
          '    raise KeyError(key) from err',
          'KeyError: \'Age\'',
          '```',
          '',
          '`df.shape` is `(214, 11)` so the file loads. `df.head()` looks completely normal.',
          'I have retyped the column name three times.'
        )
      },
      {
        thread_id: 't_plt',
        title: 'plt.show() opens a blank window and savefig writes a blank PNG',
        category: 'Debugging',
        labels: ['plotting'],
        author_id: 'u_you',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: hoursAgo(5),
        body_md: L(
          'The figure window opens but it is completely white. No error, no warning. The same',
          'code in Jupyter draws the plot fine.',
          '',
          '```python',
          'import matplotlib.pyplot as plt',
          '',
          'plt.plot([1, 2, 3], [2, 4, 8])',
          'plt.show()',
          'plt.title("Growth")',
          'plt.savefig("growth.png")',
          '```',
          '',
          '`growth.png` is blank too. matplotlib 3.8.2, Python 3.11, running the file with the',
          'VS Code Run button.'
        )
      },
      {
        thread_id: 't_listcomp',
        title: 'Why does my list comprehension give me a list of Nones?',
        category: 'Concepts',
        labels: ['python-basics'],
        author_id: 'u_ben',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: daysAgo(10),
        body_md: L(
          'I wanted a list of cleaned names. This works:',
          '',
          '```python',
          'names = ["  ana ", "BEN", " chee"]',
          'cleaned = [n.strip().title() for n in names]',
          'print(cleaned)      # [\'Ana\', \'Ben\', \'Chee\']',
          '```',
          '',
          'But when I build it up the other way I get three Nones:',
          '',
          '```python',
          'out = []',
          'result = [out.append(n.strip().title()) for n in names]',
          'print(result)       # [None, None, None]',
          'print(out)          # [\'Ana\', \'Ben\', \'Chee\']   <- this one is right',
          '```',
          '',
          'Why is `result` full of `None`? I feel like this is going to be obvious.'
        )
      },
      {
        thread_id: 't_merge',
        title: 'merge vs join in pandas - which one am I supposed to reach for?',
        category: 'Data wrangling',
        labels: ['pandas'],
        author_id: 'u_ana',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: daysAgo(6),
        body_md: L(
          'Both seem to glue two dataframes together and I cannot work out when to use which.',
          'The docs show `pd.merge(a, b)`, `a.merge(b)` and `a.join(b)` and I end up copying',
          'whichever example is closest to my situation, which is not a strategy.',
          '',
          'Is there a simple rule?'
        )
      },
      {
        thread_id: 't_ttest',
        title: 'Two-sample t-test gives p = 0.06 - do I say there is no difference?',
        category: 'Stats & interpretation',
        labels: ['statistics'],
        author_id: 'u_ben',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: daysAgo(2),
        body_md: L(
          'Comparing reaction times for two groups, n = 18 and n = 21.',
          '',
          '```python',
          'from scipy import stats',
          '',
          't, p = stats.ttest_ind(group_a, group_b, equal_var=False)',
          'print(t, p)      # -1.94  0.0603',
          '```',
          '',
          'Group means are 412 ms and 448 ms.',
          '',
          'Do I write "there was no difference between the groups"? My current draft says',
          '"approaching significance" and something tells me that is also wrong.'
        )
      },
      {
        thread_id: 't_anon',
        title: 'Assignment 1 Q3: are we allowed to use pandas, or must it be plain Python?',
        category: 'Assignments',
        labels: ['assignment'],
        author_id: 'u_ben',
        is_anonymous: true,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: hoursAgo(26),
        body_md: L(
          'Q3 says "read the file and report the mean score per group". The lecture that week',
          'only covered lists and dictionaries, but we have already used pandas in the clinic',
          'examples and it is three lines instead of twenty.',
          '',
          'Will we lose marks for using pandas instead of a dictionary and a loop?',
          '',
          'Asking anonymously because I suspect this is written somewhere obvious and I have',
          'missed it.'
        )
      }
    ];
  }

  function seedPosts() {
    return [
      {
        post_id: 'p_pin_1', thread_id: 't_welcome', parent_post_id: '',
        author_id: 'u_ana', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(37),
        body_md: 'Do we have to book a slot to ask a question, or is posting here enough?'
      },
      {
        post_id: 'p_pin_2', thread_id: 't_welcome', parent_post_id: 'p_pin_1',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(37),
        body_md: L(
          'Posting is enough, and it is the faster route for most things - you get an answer',
          'in a day and everyone else can read it.',
          '',
          'Book a slot when the problem is one of these:',
          '',
          '- something on *your* machine that I need to see (environment, paths, install)',
          '- a concept that has not landed after reading the thread',
          '- your data, which you cannot paste into a public board'
        )
      },

      {
        post_id: 'p_conda_1', thread_id: 't_conda', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: true, deleted: false,
        created_at: daysAgo(31),
        body_md: L(
          'PowerShell needs conda\'s shell hook installed once. Open **Anaconda Prompt** (not',
          'PowerShell) and run:',
          '',
          '```bash',
          'conda init powershell',
          '```',
          '',
          'Close every PowerShell window, open a new one, then:',
          '',
          '```bash',
          'conda activate phm5003',
          'python -c "import pandas; print(pandas.__version__)"',
          '```',
          '',
          'You should now see `(phm5003)` at the start of the prompt.',
          '',
          'If PowerShell then complains that running scripts is disabled, that is the',
          'execution policy, not conda. Once, in a normal (non-admin) PowerShell:',
          '',
          '```bash',
          'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
          '```',
          '',
          'Two things that cause exactly this symptom, for anyone finding this later:',
          '',
          '| Do not | Why |',
          '| --- | --- |',
          '| Tick "Add Anaconda to my PATH" at install time | `conda` is found but the shell hook is never installed, so activate silently does nothing |',
          '| Type `activate phm5003` without `conda` | Old CMD-only syntax; it fails quietly |'
        )
      },
      {
        post_id: 'p_conda_2', thread_id: 't_conda', parent_post_id: 'p_conda_1',
        author_id: 'u_ana', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(30),
        body_md: '`conda init powershell` plus a fresh window did it. Thank you - I had been ' +
          'opening Anaconda Prompt all week to dodge this.'
      },

      {
        post_id: 'p_key_1', thread_id: 't_keyerror', parent_post_id: '',
        author_id: 'u_ben', is_anonymous: false, is_accepted: true, deleted: false,
        created_at: daysAgo(17),
        body_md: L(
          'Print the columns as a list rather than looking at `df.head()` - `head()` renders',
          'whitespace invisibly, which is the whole problem:',
          '',
          '```python',
          'print(list(df.columns))',
          '```',
          '',
          'I would bet money you get something like:',
          '',
          '```python',
          '[\'Timestamp\', \' Age\', \'Gender \', \'Programme\', ...]',
          '```',
          '',
          'Survey exports love a leading space. Two fixes:',
          '',
          '```python',
          'df.columns = df.columns.str.strip()                        # trim every header',
          'df = pd.read_csv("survey_export.csv", skipinitialspace=True)   # or at read time',
          '```',
          '',
          'The same trick applies to the values, not just the headers - `" Male"` and',
          '`"Male"` are two different groups as far as `groupby` is concerned:',
          '',
          '```python',
          'df["Gender"] = df["Gender"].str.strip()',
          '```'
        )
      },
      {
        post_id: 'p_key_2', thread_id: 't_keyerror', parent_post_id: 'p_key_1',
        author_id: 'u_you', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(17),
        body_md: 'That was exactly it - `\' Age\'` with a leading space. `df.columns.str.strip()` ' +
          'fixed the whole script, and two `groupby` results that had been quietly splitting in ' +
          'two. Thank you!'
      },

      {
        post_id: 'p_plt_1', thread_id: 't_plt', parent_post_id: '',
        author_id: 'u_ana', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: hoursAgo(4),
        body_md: L(
          '`plt.show()` consumes the current figure. Everything after it is drawing onto a',
          'brand new, empty one - which is why both the window and `growth.png` are blank.',
          '',
          'Move `show()` to the end, or drop it when you are saving to a file:',
          '',
          '```python',
          'import matplotlib.pyplot as plt',
          '',
          'plt.plot([1, 2, 3], [2, 4, 8])',
          'plt.title("Growth")',
          'plt.savefig("growth.png", dpi=150, bbox_inches="tight")',
          'plt.show()      # last line, or leave it out entirely',
          '```'
        )
      },
      {
        post_id: 'p_plt_2', thread_id: 't_plt', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: hoursAgo(3),
        body_md: L(
          'Adding to that: get into the habit of the explicit object style. It makes this',
          'entire class of bug impossible, because the figure is a variable you are holding',
          'rather than a hidden global "current figure":',
          '',
          '```python',
          'fig, ax = plt.subplots(figsize=(5, 3))',
          'ax.plot([1, 2, 3], [2, 4, 8])',
          'ax.set_title("Growth")',
          'fig.savefig("growth.png", dpi=150, bbox_inches="tight")',
          '```',
          '',
          'We move to that style in week 4 anyway, so you may as well start now.'
        )
      },
      {
        post_id: 'p_plt_3', thread_id: 't_plt', parent_post_id: '',
        author_id: 'u_kai', is_anonymous: false, is_accepted: false, deleted: true,
        created_at: hoursAgo(3),
        body_md: '[this post pasted a full worked solution to Assignment 1 Q3 and was ' +
          'removed by the instructor]'
      },

      {
        post_id: 'p_lc_1', thread_id: 't_listcomp', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(10),
        body_md: L(
          'Not obvious at all - it catches everyone exactly once.',
          '',
          '`list.append()` changes the list **in place** and returns `None`. A comprehension',
          'faithfully collects whatever the expression evaluates to, so it collects three',
          '`None`s. Nothing is broken; you asked for the return value of `append`.',
          '',
          'The rule of thumb:',
          '',
          '- **Expression** - produces a value - belongs in a comprehension.',
          '- **Mutation** (`append`, `sort`, `update`) - returns `None` - belongs in a loop.',
          '',
          'So pick one style and commit to it:',
          '',
          '```python',
          'cleaned = [n.strip().title() for n in names]   # comprehension: keep the value',
          '',
          'out = []                                       # loop: mutate',
          'for n in names:',
          '    out.append(n.strip().title())',
          '```',
          '',
          'The same distinction is `sorted(xs)` versus `xs.sort()`, and in pandas it is',
          '`df.dropna()` versus `df.dropna(inplace=True)`. Once you see it you see it',
          'everywhere.'
        )
      },
      {
        post_id: 'p_lc_2', thread_id: 't_listcomp', parent_post_id: 'p_lc_1',
        author_id: 'u_ana', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(9),
        body_md: 'The `sorted(xs)` vs `xs.sort()` pairing is what made it click for me. If a ' +
          'method changes the thing you called it on, assume it hands back `None`.'
      },

      {
        post_id: 'p_mrg_1', thread_id: 't_merge', parent_post_id: '',
        author_id: 'u_ben', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(6),
        body_md: L(
          'Short version: **use `merge` and stop thinking about it.**',
          '',
          '`join` is a convenience wrapper that defaults to joining on the *index*. `merge`',
          'joins on *columns*, which is what you actually have 95% of the time.',
          '',
          '```python',
          '# a key column on both sides -> merge',
          'out = students.merge(marks, on="student_id", how="left")',
          '',
          '# differently named key columns',
          'out = students.merge(marks, left_on="id", right_on="student_id", how="left")',
          '',
          '# only when both frames are genuinely indexed by the key',
          'out = students.join(marks, how="left")',
          '```',
          '',
          'Two habits worth stealing:',
          '',
          '1. Always pass `how=` explicitly. The default for `merge` is `"inner"`, and a',
          '   silent inner join is how rows disappear without anybody noticing.',
          '2. Check the row count immediately after:',
          '',
          '```python',
          'print(len(students), "->", len(out))',
          '```',
          '',
          'If it *grew*, your right-hand key is not unique and you have made a many-to-many',
          'join by accident. `validate="m:1"` turns that into a loud error instead of a quiet',
          'mess three cells later.'
        )
      },

      {
        post_id: 'p_tt_1', thread_id: 't_ttest', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(2),
        body_md: L(
          'Neither - and well spotted, because both of those are the classic write-up traps.',
          '',
          '`p = 0.06` means: *if* the two groups really came from the same distribution, you',
          'would see a difference at least this big about 6% of the time. It is not evidence',
          'that the groups are the same, and there is no such thing as "approaching"',
          'significance - a threshold is a threshold.',
          '',
          '| Report this | Instead of |',
          '| --- | --- |',
          '| The effect size with its confidence interval | "significant" / "not significant" on its own |',
          '| "36 ms slower, 95% CI -2 to 74 ms" | "approaching significance" |',
          '| "consistent with anything from no effect to a 74 ms effect" | "there was no difference" |',
          '',
          '```python',
          'import numpy as np',
          'from scipy import stats',
          '',
          'res = stats.ttest_ind(group_a, group_b, equal_var=False)',
          'ci = res.confidence_interval(0.95)',
          'diff = np.mean(group_a) - np.mean(group_b)',
          'print(f"diff = {diff:.1f} ms, 95% CI {ci.low:.1f} to {ci.high:.1f}")',
          '```',
          '',
          'With n = 18 and 21 you simply do not have the power to resolve a 36 ms effect.',
          'Saying so plainly is a much stronger sentence than any hedge.'
        )
      },
      {
        post_id: 'p_tt_2', thread_id: 't_ttest', parent_post_id: 'p_tt_1',
        author_id: 'u_you', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(2),
        body_md: 'Is `equal_var=False` always the safe default? We were taught to test for ' +
          'equal variances first and then choose.'
      },
      {
        post_id: 'p_tt_3', thread_id: 't_ttest', parent_post_id: 'p_tt_1',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: hoursAgo(20),
        body_md: L(
          'Yes - use Welch (`equal_var=False`) by default and skip the variance test.',
          '',
          'The two-step "test then choose" procedure sounds careful but it makes your final',
          'p-value depend on the outcome of a first test, which distorts it. Welch costs you',
          'almost nothing when the variances *are* equal and saves you when they are not.',
          '',
          'It is also `scipy`\'s recommendation and R\'s default for `t.test()`, so you are in',
          'good company.'
        )
      },

      {
        post_id: 'p_anon_1', thread_id: 't_anon', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: hoursAgo(22),
        body_md: L(
          'Not obvious at all - the brief should have said, and that is on me.',
          '',
          'Use whatever you like, pandas included. The marks are for getting the right',
          'numbers and for code somebody else could read, not for which library you reached',
          'for. If the dictionary-and-loop version is clearer to you, that is a fine answer',
          'too.',
          '',
          'One condition: it has to run in the course environment (`phm5003.yml`), so no',
          'extra pip installs.',
          '',
          'I have added a line to the brief to say this.'
        )
      },
      {
        post_id: 'p_anon_2', thread_id: 't_anon', parent_post_id: 'p_anon_1',
        author_id: 'u_you', is_anonymous: true, is_accepted: false, deleted: false,
        created_at: hoursAgo(18),
        body_md: 'Same question here, so thank you for asking it. The three-line version felt ' +
          'like cheating.'
      }
    ];
  }

  /* [target_type, target_id, [voter user ids]] */
  function seedVoteSpec() {
    return [
      ['thread', 't_welcome', ['u_you', 'u_ana', 'u_ben', 'u_kai', 'u_raj', 'u_min']],
      ['thread', 't_conda', ['u_you', 'u_ben', 'u_kai', 'u_min']],
      ['thread', 't_keyerror', ['u_ana', 'u_ben', 'u_ins', 'u_kai', 'u_raj']],
      ['thread', 't_plt', ['u_ana', 'u_kai']],
      ['thread', 't_listcomp', ['u_you', 'u_ana', 'u_ins', 'u_raj']],
      ['thread', 't_merge', ['u_you', 'u_ben', 'u_min']],
      ['thread', 't_ttest', ['u_you', 'u_ins', 'u_kai']],
      ['thread', 't_anon', ['u_you', 'u_ana', 'u_kai', 'u_raj', 'u_min']],

      ['post', 'p_pin_1', ['u_you']],
      ['post', 'p_pin_2', ['u_ana', 'u_ben']],
      ['post', 'p_conda_1', ['u_you', 'u_ana', 'u_ben', 'u_kai', 'u_raj', 'u_min']],
      ['post', 'p_key_1', ['u_you', 'u_ana', 'u_ins', 'u_kai', 'u_min']],
      ['post', 'p_key_2', ['u_ben']],
      ['post', 'p_plt_1', ['u_you', 'u_ben', 'u_kai']],
      ['post', 'p_plt_2', ['u_you', 'u_ana', 'u_ben', 'u_raj']],
      ['post', 'p_lc_1', ['u_you', 'u_ana', 'u_ben', 'u_kai', 'u_raj', 'u_min']],
      ['post', 'p_lc_2', ['u_ben', 'u_kai']],
      ['post', 'p_mrg_1', ['u_you', 'u_ana', 'u_ins', 'u_kai']],
      ['post', 'p_tt_1', ['u_you', 'u_ana', 'u_ben', 'u_kai', 'u_raj', 'u_min']],
      ['post', 'p_tt_2', ['u_ana']],
      ['post', 'p_tt_3', ['u_you', 'u_ben']],
      ['post', 'p_anon_1', ['u_you', 'u_ana', 'u_kai', 'u_min']],
      ['post', 'p_anon_2', ['u_ana']]
    ];
  }

  /* Votes are dated after whatever they voted on, and mostly in the last few
     days, so the leaderboard's "This month" tab always has something in it. */
  function seedVotes(threads, posts) {
    var out = [];
    var spec = seedVoteSpec();
    var n = 0;
    for (var i = 0; i < spec.length; i++) {
      var row = spec[i];
      var target = row[0] === 'thread'
        ? find(threads, 'thread_id', row[1])
        : find(posts, 'post_id', row[1]);
      var earliest = target ? Date.parse(target.created_at) + 900000 : 0;
      for (var j = 0; j < row[2].length; j++) {
        n += 1;
        var at = nowMs() - ((n % 6) * DAY_MS + (n % 17) * 3600000);
        out.push({
          vote_id: 'v_seed_' + n,
          target_type: row[0],
          target_id: row[1],
          user_id: row[2][j],
          created_at: isoAt(Math.min(nowMs() - 60000, Math.max(at, earliest)))
        });
      }
    }
    return out;
  }

  /* Nine slots on the coming clinic day, plus last week's for admin charts. */
  function seedSlots(cfgObj, upcomingDate, pastDate) {
    var times = slotStartTimes(cfgObj);
    var duration = parseInt(cfgObj.slot_minutes, 10) || 20;
    var out = [];

    var upcomingStatus = ['open', 'open', 'booked', 'open', 'blocked', 'booked', 'open', 'open', 'open'];
    var pastStatus = ['booked', 'open', 'booked', 'open', 'open', 'booked', 'open', 'open', 'open'];

    for (var i = 0; i < times.length; i++) {
      out.push({
        slot_id: 's_past_' + (i + 1), date: pastDate, start_time: times[i],
        duration_min: duration, status: pastStatus[i] || 'open', created_at: daysAgo(14)
      });
    }
    for (var k = 0; k < times.length; k++) {
      out.push({
        slot_id: 's_next_' + (k + 1), date: upcomingDate, start_time: times[k],
        duration_min: duration, status: upcomingStatus[k] || 'open', created_at: daysAgo(7)
      });
    }
    return out;
  }

  function seedBookings(pastDate) {
    return [
      /* Upcoming clinic - two classmates have taken slots. "you" deliberately has
         none, so the booking flow is demonstrable end to end. */
      {
        booking_id: 'b_next_1', slot_id: 's_next_3', user_id: 'u_ana',
        full_name: 'Ana Rahman', phone: '+65 9123 4567', email: 'ana@u.nus.edu',
        thread_id: 't_merge', note: 'Keep ending up with more rows after a merge than I started with.',
        status: 'confirmed', attendance: '', resolved_how: '', created_at: daysAgo(2)
      },
      {
        booking_id: 'b_next_2', slot_id: 's_next_6', user_id: 'u_ben',
        full_name: 'Ben Tan', phone: '+65 8234 5678', email: 'ben@u.nus.edu',
        thread_id: 't_ttest', note: 'Want to check the wording of my results paragraph before I submit.',
        status: 'confirmed', attendance: '', resolved_how: '', created_at: daysAgo(1)
      },
      /* Last week - already marked up, so the admin dashboard has real numbers. */
      {
        booking_id: 'b_past_1', slot_id: 's_past_1', user_id: 'u_ben',
        full_name: 'Ben Tan', phone: '+65 8234 5678', email: 'ben@u.nus.edu',
        thread_id: 't_listcomp', note: '',
        status: 'confirmed', attendance: 'attended', resolved_how: 'live',
        created_at: isoFromSgt(addDaysStr(pastDate, -4), '09:00')
      },
      {
        booking_id: 'b_past_2', slot_id: 's_past_3', user_id: 'u_ana',
        full_name: 'Ana Rahman', phone: '+65 9123 4567', email: 'ana@u.nus.edu',
        thread_id: 't_conda', note: 'Environment still not right on the laptop.',
        status: 'confirmed', attendance: 'attended', resolved_how: 'live',
        created_at: isoFromSgt(addDaysStr(pastDate, -3), '20:05')
      },
      {
        booking_id: 'b_past_3', slot_id: 's_past_6', user_id: 'u_you',
        full_name: 'Demo Student', phone: '+65 8000 1234', email: 'you@u.nus.edu',
        thread_id: 't_keyerror', note: '',
        status: 'confirmed', attendance: 'no_show', resolved_how: '',
        created_at: isoFromSgt(addDaysStr(pastDate, -2), '10:15')
      },
      {
        booking_id: 'b_past_4', slot_id: 's_past_7', user_id: 'u_ben',
        full_name: 'Ben Tan', phone: '+65 8234 5678', email: 'ben@u.nus.edu',
        thread_id: 't_listcomp', note: 'Sorted it myself, sorry!',
        status: 'cancelled', attendance: '', resolved_how: '',
        created_at: isoFromSgt(addDaysStr(pastDate, -5), '08:00')
      }
    ];
  }

  function seed() {
    var cfgObj = seedConfig();
    var upcoming = nextClinicDate(cfgObj);
    var past = addDaysStr(upcoming, -7);
    var threads = seedThreads();
    var posts = seedPosts();
    return {
      v: STATE_VERSION,
      anchor: upcoming,
      seeded_at: isoAt(nowMs()),
      config: cfgObj,
      users: seedUsers(),
      threads: threads,
      posts: posts,
      votes: seedVotes(threads, posts),
      slots: seedSlots(cfgObj, upcoming, past),
      bookings: seedBookings(past),
      codes: [],
      sessions: []
    };
  }

  /* ========================================================== state lifecycle */

  var S = null;
  var dirty = false;

  function touch() { dirty = true; }

  function save() {
    try { window.localStorage.setItem(STATE_KEY, JSON.stringify(S)); }
    catch (e) { /* quota or private mode: the demo just becomes session-only */ }
  }

  /* If the signed-in browser belongs to a seeded persona, keep them signed in
     across a reseed rather than bouncing them to the login page mid-demo. */
  function rehomeSession() {
    var token = lsGet('clinic_token');
    var cached = readJSON('clinic_user');
    if (!token || !cached || !cached.email) return;
    var u = userByEmail(cached.email);
    if (!u) return;
    S.sessions.push({
      token: token, user_id: u.user_id, email: u.email,
      expires_at: isoAt(nowMs() + sessionDays() * DAY_MS), created_at: isoAt(nowMs())
    });
  }

  function init() {
    if (S) return S;
    var saved = readJSON(STATE_KEY);
    if (saved && saved.v === STATE_VERSION && saved.config &&
        saved.anchor === nextClinicDate(saved.config)) {
      S = saved;
      return S;
    }
    /* No state, wrong version, or the clinic date has rolled past - start fresh
       so the booking page always shows a bookable Thursday. */
    S = seed();
    rehomeSession();
    touch();
    return S;
  }

  function sessionDays() { return parseInt(S.config.session_days, 10) || 30; }

  /* ================================================================ lookups */

  function userById(id) { return find(S.users, 'user_id', id); }
  function userByEmail(email) {
    var e = str(email).toLowerCase();
    for (var i = 0; i < S.users.length; i++) {
      if (str(S.users[i].email).toLowerCase() === e) return S.users[i];
    }
    return null;
  }
  function threadById(id) { return find(S.threads, 'thread_id', id); }
  function postById(id) { return find(S.posts, 'post_id', id); }
  function slotById(id) { return find(S.slots, 'slot_id', id); }
  function bookingById(id) { return find(S.bookings, 'booking_id', id); }

  function actorFor(token) {
    var t = token || lsGet('clinic_token');
    if (!t) return null;
    var s = find(S.sessions, 'token', t);
    if (!s) return null;
    if (Date.parse(s.expires_at) <= nowMs()) {
      removeWhere(S.sessions, function (row) { return row.token === t; });
      touch();
      return null;
    }
    return userById(s.user_id);
  }

  function requireUser(token) {
    var u = actorFor(token);
    if (!u) fail('unauthorized', 'Your session has expired. Please sign in again.');
    return u;
  }

  function requireInstructor(token) {
    var u = requireUser(token);
    if (u.role !== 'instructor') {
      fail('forbidden', 'That area is for the instructor only.');
    }
    return u;
  }

  function mintSession(user) {
    var s = {
      token: nid('tok'), user_id: user.user_id, email: user.email,
      expires_at: isoAt(nowMs() + sessionDays() * DAY_MS), created_at: isoAt(nowMs())
    };
    S.sessions.push(s);
    user.last_login = isoAt(nowMs());
    touch();
    return s;
  }

  /* ================================================================ shaping */

  function selfUser(u) {
    return { user_id: u.user_id, display_name: u.display_name, role: u.role, email: u.email };
  }
  function publicUser(u) {
    return { user_id: u.user_id, display_name: u.display_name };
  }
  /* SPEC §5: anonymous content must never carry the real id in the payload. */
  function publicAuthor(authorId, isAnonymous) {
    if (isAnonymous) return { user_id: 'anon', display_name: 'Anonymous' };
    var u = userById(authorId);
    return u ? publicUser(u) : { user_id: authorId, display_name: 'Former student' };
  }

  function voteCount(type, id) {
    return countWhere(S.votes, function (v) {
      return v.target_type === type && v.target_id === id;
    });
  }
  function replyCount(threadId) {
    return countWhere(S.posts, function (p) {
      return p.thread_id === threadId && !p.deleted;
    });
  }

  function excerptOf(bodyMd) {
    if (Clinic.md && Clinic.md.strip) return Clinic.md.strip(bodyMd, 220);
    return str(bodyMd).replace(/\s+/g, ' ').slice(0, 220);
  }

  function threadCard(t, me) {
    return {
      thread_id: t.thread_id,
      title: t.title,
      category: t.category,
      labels: (t.labels || []).slice(),
      author: publicAuthor(t.author_id, t.is_anonymous),
      status: t.status,
      pinned: !!t.pinned,
      created_at: t.created_at,
      reply_count: replyCount(t.thread_id),
      upvotes: voteCount('thread', t.thread_id),
      accepted: !!t.accepted_post_id,
      /* SPEC §5 (patched): "did the caller write this?" without unmasking who.
         True for the caller's own ANONYMOUS threads too, while `author` stays
         {user_id:"anon"} - which is what lets booking.html list your anonymous
         threads and thread.html show you the accept button on them. It only ever
         describes the requesting user, so it reveals nothing about anyone else. */
      mine: !!(me && t.author_id === me.user_id),
      /* EXTENSION beyond SPEC §5 - a plain-text excerpt so index.html can search
         bodies as well as titles (SPEC §8). Safe to ignore; treat as optional. */
      excerpt: excerptOf(t.body_md)
    };
  }

  function threadFull(t, me) {
    var card = threadCard(t, me);
    card.body_md = t.body_md;
    card.accepted_post_id = t.accepted_post_id || '';
    card.resolved_via = t.resolved_via || '';
    return card;
  }

  function postShape(p) {
    return {
      post_id: p.post_id,
      thread_id: p.thread_id,
      parent_post_id: p.parent_post_id || '',
      body_md: p.deleted ? '' : p.body_md,
      author: publicAuthor(p.author_id, p.is_anonymous),
      is_accepted: !!p.is_accepted,
      created_at: p.created_at,
      upvotes: voteCount('post', p.post_id),
      deleted: !!p.deleted
    };
  }

  function slotShape(s) {
    return {
      slot_id: s.slot_id, date: s.date, start_time: s.start_time,
      duration_min: s.duration_min, status: s.status
    };
  }

  function bookingShape(b) {
    return {
      booking_id: b.booking_id, slot_id: b.slot_id, thread_id: b.thread_id,
      full_name: b.full_name, phone: b.phone, email: b.email,
      note: b.note, status: b.status
    };
  }

  function bootConfig() {
    return {
      site_title: S.config.site_title,
      categories: csvList(S.config.categories),
      labels: csvList(S.config.labels),
      notice_text: S.config.notice_text,
      clinic: {
        day: S.config.clinic_day,
        start: S.config.clinic_start,
        end: S.config.clinic_end,
        slot_minutes: parseInt(S.config.slot_minutes, 10) || 20,
        cutoff_day: S.config.booking_cutoff_day,
        cutoff_time: S.config.booking_cutoff_time
      },
      passcode_mode: isTrue(S.config.passcode_mode)
    };
  }

  /* Leaderboard aggregation (SPEC §8). Anonymous threads and posts are excluded
     on purpose: contrib carries real user_ids, so counting anonymous activity
     would let somebody diff the numbers before and after a post appears and work
     out who wrote it. Anonymity beats leaderboard points. */
  function contribFrom(sinceMs) {
    var rows = {};
    function row(uid) {
      if (!rows[uid]) rows[uid] = { user_id: uid, replies: 0, accepted: 0, upvotes_received: 0 };
      return rows[uid];
    }
    var i;
    for (i = 0; i < S.users.length; i++) row(S.users[i].user_id);

    function inWindow(iso) {
      return !sinceMs || Date.parse(iso) >= sinceMs;
    }

    for (i = 0; i < S.posts.length; i++) {
      var p = S.posts[i];
      if (p.deleted || p.is_anonymous || !inWindow(p.created_at)) continue;
      var r = row(p.author_id);
      r.replies += 1;
      if (p.is_accepted) r.accepted += 1;
    }

    for (i = 0; i < S.votes.length; i++) {
      var v = S.votes[i];
      if (!inWindow(v.created_at)) continue;
      var target = v.target_type === 'thread' ? threadById(v.target_id) : postById(v.target_id);
      if (!target || target.deleted || target.is_anonymous) continue;
      row(target.author_id).upvotes_received += 1;
    }

    var out = [];
    for (var key in rows) if (Object.prototype.hasOwnProperty.call(rows, key)) out.push(rows[key]);
    return out;
  }

  /* ============================================================== validation */

  function needText(value, field, min, max) {
    var v = trimmed(value);
    if (v.length < min) fail('bad_request', field + ' is too short.');
    if (v.length > max) fail('bad_request', field + ' is too long (max ' + max + ' characters).');
    return v;
  }

  function validPhone(raw) {
    var digits = str(raw).replace(/[\s()\-]/g, '');
    if (digits.indexOf('+65') === 0) digits = digits.slice(3);
    else if (digits.indexOf('65') === 0 && digits.length === 10) digits = digits.slice(2);
    return /^[89]\d{7}$/.test(digits);
  }

  function looksLikeEmail(raw) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed(raw));
  }

  /* ================================================================ handlers */

  var H = {};

  /* ------------------------------------------------------------------ auth */

  H['auth.request_code'] = function (data) {
    var email = trimmed(data.email).toLowerCase();
    if (!looksLikeEmail(email)) fail('bad_request', 'That does not look like an email address.');
    /* Demo mode accepts any domain and the code is always 000000. The live flow
       checks allowed_domains and emails a random code. */
    S.codes.push({
      code_id: nid('c'), email: email, code: '000000',
      expires_at: isoAt(nowMs() + (parseInt(S.config.code_ttl_minutes, 10) || 10) * 60000),
      used: false
    });
    touch();
    return { sent: true };
  };

  function grantSession(email, displayName) {
    var user = userByEmail(email);
    if (!user) {
      var name = trimmed(displayName);
      /* login.html relies on this exact message to know it should show the
         "pick a display name" step (SPEC §8). */
      if (!name) fail('bad_request', 'display_name_required');
      if (name.length < 2 || name.length > 40) {
        fail('bad_request', 'Pick a display name between 2 and 40 characters.');
      }
      user = {
        user_id: nid('u'), email: email, display_name: name,
        role: roleForEmail(S.config, email),
        created_at: isoAt(nowMs()), last_login: isoAt(nowMs())
      };
      S.users.push(user);
      touch();
    }
    var s = mintSession(user);
    return { token: s.token, user: selfUser(user), expires_at: s.expires_at };
  }

  H['auth.verify'] = function (data) {
    var email = trimmed(data.email).toLowerCase();
    if (!looksLikeEmail(email)) fail('bad_request', 'That does not look like an email address.');
    if (trimmed(data.code) !== '000000') {
      fail('bad_request', 'That code is not right. This is the demo site \u2014 the code is always 000000.');
    }
    return grantSession(email, data.display_name);
  };

  H['auth.passcode'] = function (data) {
    if (!isTrue(S.config.passcode_mode)) {
      fail('forbidden', 'Class passcode sign-in is switched off. Use the emailed code instead.');
    }
    var email = trimmed(data.email).toLowerCase();
    if (!looksLikeEmail(email)) fail('bad_request', 'That does not look like an email address.');
    if (trimmed(data.passcode) !== str(S.config.class_passcode)) {
      fail('forbidden', 'That class passcode is not right.');
    }
    return grantSession(email, data.display_name);
  };

  /* ------------------------------------------------------------------- app */

  H['meta.bootstrap'] = function (data, token) {
    var me = requireUser(token);
    return { config: bootConfig(), user: selfUser(me) };
  };

  H['threads.list'] = function (data, token) {
    var me = requireUser(token);
    var live = where(S.threads, function (t) { return !t.deleted; });
    return {
      threads: live.map(function (t) { return threadCard(t, me); }),
      users: S.users.map(publicUser),
      contrib: contribFrom(0),
      /* EXTENSION beyond SPEC §5: same shape, this calendar month only, so the
         leaderboard's "This month" tab (SPEC §8) is computable client-side. */
      contrib_month: contribFrom(monthStartMs())
    };
  };

  H['threads.get'] = function (data, token) {
    var me = requireUser(token);
    var t = threadById(trimmed(data.thread_id));
    if (!t || (t.deleted && me.role !== 'instructor')) {
      fail('not_found', 'That discussion no longer exists.');
    }
    var posts = where(S.posts, function (p) { return p.thread_id === t.thread_id; })
      .sort(function (a, b) { return Date.parse(a.created_at) - Date.parse(b.created_at); });
    var mine = where(S.votes, function (v) { return v.user_id === me.user_id; })
      .map(function (v) { return v.target_id; });
    return { thread: threadFull(t, me), posts: posts.map(postShape), my_votes: mine };
  };

  H['threads.create'] = function (data, token) {
    var me = requireUser(token);
    var title = needText(data.title, 'Title', 4, 200);
    var body = needText(data.body_md, 'Body', 2, 20000);
    var category = trimmed(data.category);
    if (csvList(S.config.categories).indexOf(category) === -1) {
      fail('bad_request', 'Choose a category from the list.');
    }
    var known = csvList(S.config.labels);
    var labels = (data.labels || []).map(trimmed).filter(function (l) {
      return known.indexOf(l) !== -1;
    }).slice(0, 5);

    var t = {
      thread_id: nid('t'), title: title, body_md: body, category: category,
      labels: labels, author_id: me.user_id, is_anonymous: !!data.is_anonymous,
      status: 'open', accepted_post_id: '', resolved_via: '',
      pinned: false, deleted: false, created_at: isoAt(nowMs())
    };
    S.threads.push(t);
    touch();
    return { thread_id: t.thread_id };
  };

  H['posts.create'] = function (data, token) {
    var me = requireUser(token);
    var t = threadById(trimmed(data.thread_id));
    if (!t || t.deleted) fail('not_found', 'That discussion no longer exists.');
    var body = needText(data.body_md, 'Reply', 2, 20000);

    var parentId = trimmed(data.parent_post_id);
    if (parentId) {
      var parent = postById(parentId);
      if (!parent || parent.thread_id !== t.thread_id || parent.deleted) {
        fail('not_found', 'The reply you are responding to has gone.');
      }
      /* One level of nesting only (SPEC §4): a reply to a reply lands flat
         underneath the same top-level post. */
      parentId = parent.parent_post_id || parent.post_id;
    }

    var p = {
      post_id: nid('p'), thread_id: t.thread_id, parent_post_id: parentId,
      body_md: body, author_id: me.user_id, is_anonymous: !!data.is_anonymous,
      is_accepted: false, deleted: false, created_at: isoAt(nowMs())
    };
    S.posts.push(p);
    touch();
    return { post_id: p.post_id };
  };

  H['votes.toggle'] = function (data, token) {
    var me = requireUser(token);
    var type = trimmed(data.target_type);
    var id = trimmed(data.target_id);
    if (type !== 'thread' && type !== 'post') fail('bad_request', 'Unknown vote target.');

    var target = type === 'thread' ? threadById(id) : postById(id);
    if (!target || target.deleted) fail('not_found', 'That post no longer exists.');
    if (target.author_id === me.user_id) {
      fail('forbidden', 'You cannot upvote your own post.');
    }

    var existing = null;
    for (var i = 0; i < S.votes.length; i++) {
      var v = S.votes[i];
      if (v.target_type === type && v.target_id === id && v.user_id === me.user_id) {
        existing = v; break;
      }
    }
    if (existing) {
      removeWhere(S.votes, function (row) { return row === existing; });
      touch();
      return { voted: false, count: voteCount(type, id) };
    }
    S.votes.push({
      vote_id: nid('v'), target_type: type, target_id: id,
      user_id: me.user_id, created_at: isoAt(nowMs())
    });
    touch();
    return { voted: true, count: voteCount(type, id) };
  };

  H['threads.accept'] = function (data, token) {
    var me = requireUser(token);
    var t = threadById(trimmed(data.thread_id));
    if (!t || t.deleted) fail('not_found', 'That discussion no longer exists.');
    if (t.author_id !== me.user_id && me.role !== 'instructor') {
      fail('forbidden', 'Only the person who asked (or the instructor) can mark an answer.');
    }
    var p = postById(trimmed(data.post_id));
    if (!p || p.thread_id !== t.thread_id || p.deleted) {
      fail('not_found', 'That reply no longer exists.');
    }
    if (p.parent_post_id) {
      fail('bad_request', 'Only a top-level reply can be marked as the answer.');
    }
    for (var i = 0; i < S.posts.length; i++) {
      if (S.posts[i].thread_id === t.thread_id) S.posts[i].is_accepted = false;
    }
    p.is_accepted = true;
    t.accepted_post_id = p.post_id;
    t.status = 'answered';
    if (t.resolved_via !== 'live') t.resolved_via = 'async';
    touch();
    return { ok: true };
  };

  H['profile.update'] = function (data, token) {
    var me = requireUser(token);
    me.display_name = needText(data.display_name, 'Display name', 2, 40);
    touch();
    return { user: selfUser(me) };
  };

  /* ---------------------------------------------------------------- slots */

  function activeBookingsFor(userId) {
    return where(S.bookings, function (b) {
      if (b.user_id !== userId || b.status !== 'confirmed') return false;
      var s = slotById(b.slot_id);
      return !!s && Date.parse(isoFromSgt(s.date, s.start_time)) >= nowMs();
    });
  }

  H['slots.list'] = function (data, token) {
    var me = requireUser(token);
    var horizon = nowMs() + 21 * DAY_MS;
    var floor = todayStartMs();
    var upcoming = where(S.slots, function (s) {
      var at = Date.parse(isoFromSgt(s.date, s.start_time));
      return at >= floor && at <= horizon;
    }).sort(function (a, b) {
      return Date.parse(isoFromSgt(a.date, a.start_time)) -
        Date.parse(isoFromSgt(b.date, b.start_time));
    });

    var cutoffIso = upcoming.length
      ? cutoffForDate(S.config, upcoming[0].date)
      : nextCutoffIso(S.config);

    var mine = activeBookingsFor(me.user_id);
    return {
      slots: upcoming.map(slotShape),
      my_booking: mine.length ? bookingShape(mine[0]) : null,
      cutoff_iso: cutoffIso
    };
  };

  H['slots.book'] = function (data, token) {
    var me = requireUser(token);
    var slot = slotById(trimmed(data.slot_id));
    if (!slot) fail('not_found', 'That slot no longer exists.');

    var cutoffIso = cutoffForDate(S.config, slot.date);
    if (nowMs() > Date.parse(cutoffIso)) {
      fail('cutoff_passed', 'Bookings for that clinic closed at the cutoff. Email the instructor if it is urgent.');
    }
    if (slot.status !== 'open') fail('conflict', 'Somebody just took that slot. Pick another one.');

    var max = parseInt(S.config.max_active_bookings, 10) || 1;
    if (activeBookingsFor(me.user_id).length >= max) {
      fail('conflict', 'You already have a clinic booking. Cancel it first if you want to move.');
    }

    var t = threadById(trimmed(data.thread_id));
    if (!t || t.deleted) fail('not_found', 'Pick one of your own discussion threads.');
    if (t.author_id !== me.user_id) {
      fail('forbidden', 'You can only book a slot about a thread you posted yourself.');
    }

    var fullName = needText(data.full_name, 'Full name', 2, 80);
    var email = trimmed(data.email);
    if (!looksLikeEmail(email)) fail('bad_request', 'Enter the email address you want the confirmation sent to.');
    if (!validPhone(data.phone)) {
      fail('bad_request', 'Enter a Singapore mobile number, e.g. 9123 4567.');
    }
    var note = str(data.note).slice(0, 300);

    var b = {
      booking_id: nid('b'), slot_id: slot.slot_id, user_id: me.user_id,
      full_name: fullName, phone: trimmed(data.phone), email: email,
      thread_id: t.thread_id, note: note, status: 'confirmed',
      attendance: '', resolved_how: '', created_at: isoAt(nowMs())
    };
    S.bookings.push(b);
    slot.status = 'booked';
    touch();
    return { booking_id: b.booking_id };
  };

  H['slots.cancel'] = function (data, token) {
    var me = requireUser(token);
    var b = bookingById(trimmed(data.booking_id));
    if (!b || b.user_id !== me.user_id) fail('not_found', 'We could not find that booking.');
    if (b.status !== 'confirmed') fail('conflict', 'That booking has already been cancelled.');

    var slot = slotById(b.slot_id);
    if (slot && nowMs() > Date.parse(cutoffForDate(S.config, slot.date))) {
      fail('cutoff_passed', 'It is past the cutoff \u2014 email the instructor to cancel.');
    }
    b.status = 'cancelled';
    if (slot && slot.status === 'booked') slot.status = 'open';
    touch();
    return { ok: true };
  };

  /* ---------------------------------------------------------------- admin */

  H['admin.export'] = function (data, token) {
    requireInstructor(token);
    /* The one place anonymity is pierced: raw rows, real author ids, booking PII.
       Booleans are real booleans and labels are arrays - the live ADMIN flow must
       coerce Excel's "TRUE"/"FALSE" strings and comma lists to match. */
    return {
      threads: clone(S.threads),
      posts: clone(S.posts),
      votes: clone(S.votes),
      users: clone(S.users),
      slots: clone(S.slots),
      bookings: clone(S.bookings),
      config: clone(S.config)
    };
  };

  H['admin.moderate'] = function (data, token) {
    requireInstructor(token);
    var op = trimmed(data.op);
    var t, p;

    function needThread() {
      var th = threadById(trimmed(data.thread_id));
      if (!th) fail('not_found', 'That discussion no longer exists.');
      return th;
    }
    function needPost() {
      var po = postById(trimmed(data.post_id));
      if (!po) fail('not_found', 'That reply no longer exists.');
      return po;
    }

    switch (op) {
      case 'delete_thread':
        t = needThread(); t.deleted = true; break;
      case 'restore_thread':                       /* not in SPEC §5's op list, but
                                                      SPEC §8 tab 2 offers restore */
        t = needThread(); t.deleted = false; break;
      case 'delete_post':
        p = needPost(); p.deleted = true;
        if (p.is_accepted) {
          p.is_accepted = false;
          t = threadById(p.thread_id);
          if (t && t.accepted_post_id === p.post_id) {
            t.accepted_post_id = ''; t.status = 'open'; t.resolved_via = '';
          }
        }
        break;
      case 'restore_post':
        p = needPost(); p.deleted = false; break;
      case 'pin_thread':
        t = needThread(); t.pinned = true; break;
      case 'unpin_thread':
        t = needThread(); t.pinned = false; break;
      case 'set_labels':
        t = needThread();
        var known = csvList(S.config.labels);
        t.labels = (data.labels || []).map(trimmed).filter(function (l) {
          return known.indexOf(l) !== -1;
        });
        break;
      case 'set_category':
        t = needThread();
        var cat = trimmed(data.category);
        if (csvList(S.config.categories).indexOf(cat) === -1) {
          fail('bad_request', 'Unknown category.');
        }
        t.category = cat;
        break;
      case 'set_resolved_via':
        t = needThread();
        var via = trimmed(data.resolved_via);
        if (['', 'live', 'async'].indexOf(via) === -1) fail('bad_request', 'Unknown resolution.');
        t.resolved_via = via;
        break;
      default:
        fail('bad_request', 'Unknown moderation action: ' + op);
    }
    touch();
    return { ok: true };
  };

  H['admin.slots.upsert'] = function (data, token) {
    requireInstructor(token);
    var rows = data.slots || [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var existing = row.slot_id ? slotById(trimmed(row.slot_id)) : null;
      if (existing) {
        if (row.date) existing.date = trimmed(row.date);
        if (row.start_time) existing.start_time = trimmed(row.start_time);
        if (row.duration_min) existing.duration_min = parseInt(row.duration_min, 10) || existing.duration_min;
        if (row.status) existing.status = trimmed(row.status);
      } else {
        if (!row.date || !row.start_time) fail('bad_request', 'A slot needs a date and a start time.');
        S.slots.push({
          slot_id: nid('s'), date: trimmed(row.date), start_time: trimmed(row.start_time),
          duration_min: parseInt(row.duration_min, 10) || (parseInt(S.config.slot_minutes, 10) || 20),
          status: trimmed(row.status) || 'open', created_at: isoAt(nowMs())
        });
      }
    }
    touch();
    return { ok: true };
  };

  H['admin.slots.generate'] = function (data, token) {
    requireInstructor(token);
    var weeks = parseInt(data.weeks, 10) || 1;
    if (weeks < 1) weeks = 1;
    if (weeks > 12) weeks = 12;
    var times = slotStartTimes(S.config);
    var duration = parseInt(S.config.slot_minutes, 10) || 20;
    var date = nextClinicDate(S.config);
    var created = 0;
    for (var w = 0; w < weeks; w++) {
      for (var i = 0; i < times.length; i++) {
        var clash = false;
        for (var k = 0; k < S.slots.length; k++) {
          if (S.slots[k].date === date && S.slots[k].start_time === times[i]) { clash = true; break; }
        }
        if (clash) continue;
        S.slots.push({
          slot_id: nid('s'), date: date, start_time: times[i],
          duration_min: duration, status: 'open', created_at: isoAt(nowMs())
        });
        created += 1;
      }
      date = addDaysStr(date, 7);
    }
    touch();
    return { created: created };
  };

  H['admin.booking.update'] = function (data, token) {
    requireInstructor(token);
    var b = bookingById(trimmed(data.booking_id));
    if (!b) fail('not_found', 'We could not find that booking.');

    if (data.attendance !== undefined) {
      var att = trimmed(data.attendance);
      if (['', 'attended', 'no_show'].indexOf(att) === -1) fail('bad_request', 'Unknown attendance value.');
      b.attendance = att;
    }
    if (data.resolved_how !== undefined) {
      var how = trimmed(data.resolved_how);
      if (['', 'live', 'escalated'].indexOf(how) === -1) fail('bad_request', 'Unknown resolution value.');
      b.resolved_how = how;
      if (how === 'live') {
        var t = threadById(b.thread_id);
        if (t) { t.resolved_via = 'live'; t.status = 'answered'; }
      }
    }
    if (data.status !== undefined) {
      var st = trimmed(data.status);
      if (['confirmed', 'cancelled', 'rejected'].indexOf(st) === -1) fail('bad_request', 'Unknown booking status.');
      b.status = st;
      var slot = slotById(b.slot_id);
      if (slot) slot.status = (st === 'confirmed') ? 'booked' : 'open';
    }
    touch();
    return { ok: true };
  };

  var CONFIG_WHITELIST = [
    'site_title', 'notice_text', 'categories', 'labels',
    'clinic_day', 'clinic_start', 'clinic_end', 'slot_minutes',
    'booking_cutoff_day', 'booking_cutoff_time', 'max_active_bookings',
    'passcode_mode', 'class_passcode'
  ];

  H['admin.config.set'] = function (data, token) {
    requireInstructor(token);
    var entries = data.entries || {};
    for (var key in entries) {
      if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
      if (CONFIG_WHITELIST.indexOf(key) === -1) continue;
      var value = entries[key];
      if (Object.prototype.toString.call(value) === '[object Array]') value = value.join(',');
      if (value === true || value === false) value = value ? 'TRUE' : 'FALSE';
      S.config[key] = str(value);
    }
    touch();
    return { ok: true };
  };

  /* ================================================================ dispatch */

  function handle(action, data, token) {
    return new Promise(function (resolve, reject) {
      window.setTimeout(function () {
        try {
          init();
          var fn = H[action];
          if (!fn) {
            reject({ code: 'bad_request', message: 'Unknown action in demo mode: ' + action });
            return;
          }
          var out = fn(data || {}, token || lsGet('clinic_token') || '');
          if (dirty) { save(); dirty = false; }
          resolve(out === undefined ? {} : out);
        } catch (e) {
          if (dirty) { save(); dirty = false; }
          if (e && e.code) reject(e);
          else reject({ code: 'bad_request', message: (e && e.message) || 'Demo data error.' });
        }
      }, LATENCY_MS);
    });
  }

  /* ============================================================ demo controls */

  function personaUser(which) {
    init();
    if (which === 'instructor') {
      return find(S.users, 'role', 'instructor') || userById('u_ins');
    }
    return userById('u_you');
  }

  /* Used by the mock-only user switcher in the header (SPEC §13.2). */
  function switchUser(which, opts) {
    init();
    var user = personaUser(which);
    if (!user) fail('not_found', 'No demo persona for "' + which + '".');
    var s = mintSession(user);
    lsSet('clinic_token', s.token);
    lsSet('clinic_user', JSON.stringify(selfUser(user)));
    lsSet('clinic_token_expires', s.expires_at);
    lsDel('clinic_bootstrap');
    save();
    dirty = false;
    if (!opts || opts.reload !== false) window.location.reload();
    return selfUser(user);
  }

  function signOut() {
    init();
    var token = lsGet('clinic_token');
    if (token) {
      removeWhere(S.sessions, function (row) { return row.token === token; });
      save();
      dirty = false;
    }
  }

  function reset(opts) {
    lsDel(STATE_KEY);
    lsDel('clinic_token');
    lsDel('clinic_user');
    lsDel('clinic_token_expires');
    lsDel('clinic_bootstrap');
    S = null;
    init();
    save();
    dirty = false;
    if (!opts || opts.reload !== false) window.location.reload();
    return 'Demo data reset.';
  }

  function personas() {
    init();
    var you = userById('u_you');
    var ins = find(S.users, 'role', 'instructor');
    var out = [];
    if (you) out.push({ key: 'student', user_id: you.user_id, display_name: you.display_name, email: you.email, role: you.role });
    if (ins) out.push({ key: 'instructor', user_id: ins.user_id, display_name: ins.display_name, email: ins.email, role: ins.role });
    return out;
  }

  function hint() {
    init();
    var ins = find(S.users, 'role', 'instructor');
    return 'Demo mode: any email address works and the code is always 000000. ' +
      'Sign in as you@u.nus.edu for a student with existing threads, or ' +
      (ins ? ins.email : 'the instructor address') + ' for the instructor view.';
  }

  Clinic.mock = {
    handle: handle,
    reset: reset,
    switchUser: switchUser,
    signOut: signOut,
    personas: personas,
    hint: hint,
    state: function () { init(); return S; },
    STATE_KEY: STATE_KEY,
    STATE_VERSION: STATE_VERSION
  };

})(window);
