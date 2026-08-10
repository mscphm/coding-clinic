/* ============================================================================
 * templates.js — per-category ask templates (v3 contract §10.5, D7)
 * ----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * The single most common reason a clinic question sits unanswered for a day is
 * not that it is hard — it is that nobody can tell what was actually run, on
 * what, or what exactly came back. "It doesn't work" costs a round trip of
 * 24 hours. So the composer hands the student the skeleton of an answerable
 * question, per category, and the skeleton itself does the teaching.
 *
 * The four headings are pinned by the contract and are identical in all eight
 * templates:
 *     ## What I'm trying to do
 *     ## The exact error
 *     ## Minimal code
 *     ## What I already tried
 * Everything else — the order they appear in, the prompt under each, and the
 * extra section a category needs — is tailored. A "Concepts" question and an
 * "Environment & setup" question are not the same shape, and pretending they
 * are is how you end up with eight identical, ignored skeletons.
 *
 * DATA ONLY. This file makes no network call, reads no config, and cannot
 * fail. §10.10: "Templates — front-end JSON — never degrades."
 *
 * ----------------------------------------------------------------------------
 * THE PROMPT STYLE, AND WHY IT IS NOT AN HTML COMMENT
 *
 * The obvious choice for "a prompt the student replaces" is <!-- like this -->.
 * It is the wrong choice here: markdown.js runs everything through DOMPurify,
 * which strips comments, so a student who leaves the prompts in posts a thread
 * whose sections render *completely empty* — and neither they nor the reader
 * can see why. Instead each prompt is a one-line markdown italic (_like this_).
 * A leftover prompt is then visible to everyone, which is honest, and deleting
 * it is one triple-click.
 *
 * ----------------------------------------------------------------------------
 * THE FENCE LANGUAGE
 *
 * Bodies carry a `%L%` token where a fenced code block's language goes.
 * forCategory(category, language) substitutes it ('Python' -> python,
 * 'R' -> r, 'Bash/Linux' -> bash, anything else -> nothing), so a student on
 * the R board gets ```r and syntax highlighting works on the very first post.
 *
 * That substitution is exactly why isTemplate() normalises the info string off
 * every fence line before comparing. isTemplate() is load-bearing: it is the
 * ONLY thing standing between "switch category twice" and "silently destroyed
 * a student's half-written question". If it ever returns false for a body this
 * file produced, work is lost. Hence: compare against every generic body, with
 * fence info strings, trailing spaces, CRLF and blank-line runs normalised
 * away, and nothing else.
 *
 * ES5 only, IIFE, window.Clinic.templates. See the house style note in ui.js.
 * ==========================================================================*/
(function (window, document) {
  'use strict';

  var Clinic = window.Clinic = window.Clinic || {};

  /* Line joiner. Same idiom as mock-data.js's L() — writing these bodies as
     one long string literal with \n everywhere is unreadable and unreviewable,
     and a template nobody can read is a template nobody will fix. */
  function L() {
    return Array.prototype.slice.call(arguments).join('\n');
  }

  /* Placeholder for a fenced block's language. Substituted by render(). */
  var LTOK = '%L%';

  /* cfg.languages values -> highlight.js / marked info strings. Unknown or
     blank languages fall through to '' (a bare fence), which is still valid
     markdown and still renders. Never guess: a Python fence on R code is
     worse than no fence at all. */
  var FENCE = {
    'Python': 'python',
    'R': 'r',
    'Bash/Linux': 'bash'
  };

  /* The shared "paste it whole" instruction. Written once so all eight say the
     same thing in the same words — students learn a rule faster when it does
     not get reworded per category. */
  var WHOLE = '_The WHOLE message, copied and unedited. The first line is rarely ' +
    'the useful one, and the last line is rarely the whole story._';

  /* --------------------------------------------------------------- bodies */

  var TEMPLATES = [
    {
      id: 'environment',
      category: 'Environment & setup',
      label: 'Environment & setup',
      /* Setup questions are answerable almost entirely from the machine
         details, and almost never answerable without them — so this one leads
         with a checklist rather than prose. */
      body: L(
        "## What I'm trying to do",
        '_Install, configure or run what — and on which machine?_',
        '',
        '## My setup',
        '- Operating system and version:',
        '- Python / R version (`python --version`, `R --version`):',
        '- How it was installed (Anaconda, python.org, Homebrew, apt, the NUS lab image):',
        '- Where you are running it (Terminal, PowerShell, VS Code, RStudio, Jupyter):',
        '',
        '## Minimal code',
        '_The exact command you typed — copied out of the terminal, not retyped from memory._',
        '',
        '```' + LTOK,
        '',
        '```',
        '',
        '## The exact error',
        WHOLE,
        '',
        '```',
        '',
        '```',
        '',
        '## What I already tried',
        '_Reinstalled? Different terminal? Different folder? Say what changed and what happened._',
        '',
        '- ',
        '- '
      )
    },

    {
      id: 'syntax',
      category: 'Syntax & errors',
      label: 'Syntax & errors',
      /* For a syntax error the traceback IS the question, so it comes early
         and the "minimal" instruction is made concrete. */
      body: L(
        "## What I'm trying to do",
        '_One or two sentences. What should this code produce?_',
        '',
        '## Minimal code',
        '_The smallest snippet that still fails. Delete every line the error does not need — ' +
          'doing that alone solves it surprisingly often._',
        '',
        '```' + LTOK,
        '',
        '```',
        '',
        '## The exact error',
        WHOLE + ' _Include the line number and the caret/arrow line if there is one._',
        '',
        '```',
        '',
        '```',
        '',
        '## What I already tried',
        '_What you changed, and what the error said after you changed it._',
        '',
        '- ',
        '- '
      )
    },

    {
      id: 'concepts',
      category: 'Concepts',
      label: 'Concepts',
      /* A concept question usually has no error at all, so the scaffolding
         that matters is "say what you currently believe". Being specific about
         the WRONG version is what makes a concept question answerable — an
         answer can then correct one belief instead of re-teaching a topic. */
      body: L(
        "## What I'm trying to do",
        '_The idea you are trying to get straight, and where it came up (lecture, reading, an assignment)._',
        '',
        '## Where my understanding stops',
        '_Write out what you currently think is true, even if you suspect it is wrong. ' +
          'Naming the wrong version is what turns a lecture into an answer._',
        '',
        '## Minimal code',
        '_Optional. Include a tiny example only if it makes the question concrete — ' +
          'otherwise delete this section._',
        '',
        '```' + LTOK,
        '',
        '```',
        '',
        '## The exact error',
        '_Concept questions often have none. If something did go wrong, paste it whole; ' +
          'if not, leave the line below as it is._',
        '',
        '```',
        'no error - this is a concept question',
        '```',
        '',
        '## What I already tried',
        '_What you have already read, watched or asked, and which part did not land._',
        '',
        '- ',
        '- '
      )
    },

    {
      id: 'debugging',
      category: 'Debugging',
      label: 'Debugging',
      /* The defining feature of a debugging question is that "expected" and
         "actual" must BOTH be stated. Code that runs and gives the wrong
         answer has no traceback, so the error section explicitly asks for the
         wrong output instead. */
      body: L(
        "## What I'm trying to do",
        '_What the code should do, and what it does instead. Both, explicitly._',
        '',
        '## Minimal code',
        '_The smallest version that still misbehaves. If the data matters, include two or ' +
          'three made-up rows so someone else can run it._',
        '',
        '```' + LTOK,
        '',
        '```',
        '',
        '## The exact error',
        '_Full traceback if it crashes._ _If it does NOT crash, paste the wrong output here ' +
          'and say what you expected instead — that is the error._',
        '',
        '```',
        '',
        '```',
        '',
        '## What I already tried',
        '_Which lines you have already printed, checked or commented out, and what you learned._',
        '',
        '- ',
        '- '
      )
    },

    {
      id: 'data',
      category: 'Data wrangling',
      label: 'Data wrangling',
      /* Wrangling questions are shape questions. Almost all of them dissolve
         once "what I have" and "what I want" are both written down, so this
         template asks for a text head() — never a screenshot of a spreadsheet,
         which cannot be copied, run, or read on a phone. */
      body: L(
        "## What I'm trying to do",
        '_The shape you have and the shape you want. "One row per student per week, from one ' +
          'row per student" beats "reshape my data"._',
        '',
        '## What the data looks like',
        '_A few rows as TEXT — `df.head()`, `df.dtypes`, `str(df)`, `head(df)`. ' +
          'Not a screenshot of Excel: nobody can run a screenshot._',
        '',
        '```',
        '',
        '```',
        '',
        '## Minimal code',
        '',
        '```' + LTOK,
        '',
        '```',
        '',
        '## The exact error',
        '_Full message._ _If there is no error but the result is wrong, paste the result you ' +
          'got and the result you wanted._',
        '',
        '```',
        '',
        '```',
        '',
        '## What I already tried',
        '',
        '- ',
        '- '
      )
    },

    {
      id: 'stats',
      category: 'Stats & interpretation',
      label: 'Stats & interpretation',
      /* "Which test should I use" is unanswerable without the design, and
         answerable in one line with it. So the design checklist is the body of
         the question and the code is secondary — the reverse of every other
         template here. */
      body: L(
        "## What I'm trying to do",
        '_The question you are asking of the data, in plain words, before any test names. ' +
          '"Does score change over time within a person?" not "should I use ANOVA?"_',
        '',
        '## The design',
        '- What one row is (one row per …):',
        '- Outcome variable, and its type (continuous / count / binary / ordinal):',
        '- Predictor(s) or group(s), and their type:',
        '- Anything paired, repeated or nested (same person measured twice, students within class):',
        '- Sample size:',
        '',
        '## Minimal code',
        '',
        '```' + LTOK,
        '',
        '```',
        '',
        '## The exact error',
        '_The output you are trying to read, pasted whole — estimates, standard errors, ' +
          'p-values and all. Or the error message, if it errored._',
        '',
        '```',
        '',
        '```',
        '',
        '## What I already tried',
        '_Which interpretation you are leaning towards, and what makes you unsure of it._',
        '',
        '- ',
        '- '
      )
    },

    {
      id: 'assignments',
      category: 'Assignments',
      label: 'Assignments',
      /* The integrity rule already lives in the board notice (tbl_Config
         notice_text, rendered in the sidebar). Restating it INSIDE the body
         the student is about to write is deliberate: the sidebar is read once,
         on the first visit; the composer is read every time, and it is the
         moment the temptation actually arrives. It stays in the posted thread
         too, which is where a would-be answerer sees it.

         Note it is a blockquote, not a heading — it must not look like a
         section the student is supposed to fill in. */
      body: L(
        '> **Assignment ground rule:** ask about the *error*, the *concept* or the *approach*.',
        '> Do not paste your full answer, do not ask for solution code, and do not post ' +
          'anyone else\'s. Replies that hand over a solution are removed.',
        '',
        "## What I'm trying to do",
        '_The one step you are stuck on, described without pasting your whole answer._',
        '',
        '## Minimal code',
        '_A cut-down version that shows the problem — ideally on two or three made-up rows ' +
          'rather than the assignment data itself._',
        '',
        '```' + LTOK,
        '',
        '```',
        '',
        '## The exact error',
        WHOLE,
        '',
        '```',
        '',
        '```',
        '',
        '## What I already tried',
        '',
        '- ',
        '- ',
        '',
        '_Tick "Post anonymously" below if you would rather your name were not on this one._'
      )
    },

    {
      id: 'general',
      category: 'General',
      label: 'General',
      /* The catch-all. Two sections are explicitly marked deletable, because
         a template that forces an empty "The exact error" block onto a
         question about which laptop to buy trains students to ignore it. */
      body: L(
        "## What I'm trying to do",
        '_What you are working on, and what you would like to happen._',
        '',
        '## Minimal code',
        '_Only if code is involved — otherwise delete this section._',
        '',
        '```' + LTOK,
        '',
        '```',
        '',
        '## The exact error',
        '_Only if something errored. Paste it whole and unedited — otherwise delete this section._',
        '',
        '```',
        '',
        '```',
        '',
        '## What I already tried',
        '',
        '- ',
        '- '
      )
    }
  ];

  /* ------------------------------------------------------------ rendering */

  function fenceFor(language) {
    var key = String(language == null ? '' : language).trim();
    if (!key) return '';
    if (FENCE[key]) return FENCE[key];
    /* An unrecognised board name (config.languages is instructor-editable and
       can grow) is passed through lowercased if it is a plain word — 'SQL'
       becomes ```sql, which is right far more often than ``` alone. Anything
       with punctuation or spaces gets a bare fence rather than a guess. */
    if (/^[A-Za-z][A-Za-z0-9+#]*$/.test(key)) return key.toLowerCase();
    return '';
  }

  function render(tpl, language) {
    var fence = fenceFor(language);
    return {
      id: tpl.id,
      label: tpl.label,
      category: tpl.category,
      body: tpl.body.split(LTOK).join(fence)
    };
  }

  /* --------------------------------------------------------------- lookup */

  function all() {
    /* Generic (language-free) bodies, per §10.5. Callers that want a fence
       language ask forCategory()/get() for it. */
    return TEMPLATES.map(function (t) { return render(t, ''); });
  }

  function get(id, language) {
    var key = String(id == null ? '' : id);
    for (var i = 0; i < TEMPLATES.length; i++) {
      if (TEMPLATES[i].id === key) return render(TEMPLATES[i], language);
    }
    return null;
  }

  /* Exact match on cfg.categories first — those strings are the contract.
     The case-insensitive second pass exists only because tbl_Config is a text
     box an instructor edits by hand, and "concepts" costing every student
     their template would be an absurd way to lose the feature. */
  function forCategory(category, language) {
    var key = String(category == null ? '' : category).trim();
    if (!key) return null;
    var i;
    for (i = 0; i < TEMPLATES.length; i++) {
      if (TEMPLATES[i].category === key) return render(TEMPLATES[i], language);
    }
    var lower = key.toLowerCase();
    for (i = 0; i < TEMPLATES.length; i++) {
      if (TEMPLATES[i].category.toLowerCase() === lower) return render(TEMPLATES[i], language);
    }
    return null;
  }

  /* --------------------------------------------------------- recognition */

  /* Normalise away everything that a render or an editor can legitimately
     change without the text ceasing to be an untouched template:
       - CRLF vs LF (a Windows student pasting into a textarea)
       - the info string on a fence line (```python vs ```r vs ```)
       - trailing whitespace on a line
       - runs of blank lines, and leading/trailing blank lines
     Nothing else. In particular this does NOT lowercase and does NOT collapse
     spaces inside a line: if a student has edited a single word, that is their
     work and isTemplate() must say so. */
  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/^[ \t]*```[^\n`]*$/gm, '```')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
  }

  function isTemplate(text) {
    var t = norm(text);
    if (!t) return false;                 /* empty is not "a template" */
    for (var i = 0; i < TEMPLATES.length; i++) {
      if (norm(TEMPLATES[i].body) === t) return true;
    }
    return false;
  }

  /* ----------------------------------------------------------- application */

  function fireInput(ta) {
    var ev;
    try { ev = new window.Event('input', { bubbles: true }); }
    catch (e) {
      ev = document.createEvent('Event');
      ev.initEvent('input', true, false);
    }
    ta.dispatchEvent(ev);
  }

  /* End of the first section = just before the second '## ' heading (or the
     end of the text when there is only one). That is where a student starts
     typing, and putting the caret there means the very first keystroke lands
     in the right place instead of at character 0, above the title. */
  function firstSectionEnd(body) {
    var re = /^##[ \t]/gm;
    var first = re.exec(body);
    if (!first) return body.length;
    var second = re.exec(body);
    if (!second) return body.length;
    var idx = second.index;
    while (idx > 0 && (body.charAt(idx - 1) === '\n' || body.charAt(idx - 1) === ' ')) idx--;
    return idx;
  }

  function setCaret(ta, pos, focus) {
    try {
      ta.selectionStart = pos;
      ta.selectionEnd = pos;
    } catch (e) { /* detached or not yet laid out — harmless */ }
    /* Deliberately NOT focused by default. apply() runs on a <select> change,
       and yanking focus out of the category picker mid-keyboard-navigation is
       hostile. The caret position is still remembered for when the student
       does reach the textarea. Explicit button paths pass focus:true. */
    if (focus) { try { ta.focus(); } catch (e2) { /* ignore */ } }
  }

  /* apply(textarea, template[, opts]) -> bool
     REFUSES and touches nothing when the box holds text this file did not
     write. That refusal is the whole safety property; the caller decides what
     to offer instead (new.js offers Insert below / Replace). */
  function apply(ta, template, opts) {
    if (!ta || !template || typeof template.body !== 'string') return false;
    opts = opts || {};
    var cur = ta.value || '';
    if (cur.replace(/\s+/g, '') !== '' && !isTemplate(cur)) return false;

    ta.value = template.body;
    setCaret(ta, firstSectionEnd(template.body), !!opts.focus);
    fireInput(ta);
    return true;
  }

  /* EXTRA (not in §10.5): the non-destructive alternative. Appends the
     template below whatever the student has written, separated by a blank
     line, and drops the caret into the appended copy's first section. This is
     what "never destroy typed text" looks like when the student still wants
     the skeleton. */
  function appendTo(ta, template, opts) {
    if (!ta || !template || typeof template.body !== 'string') return false;
    opts = opts || {};
    var cur = ta.value || '';
    if (cur.replace(/\s+/g, '') === '') return apply(ta, template, opts);

    var sep = /\n\s*\n$/.test(cur) ? '' : (/\n$/.test(cur) ? '\n' : '\n\n');
    var offset = cur.length + sep.length;
    ta.value = cur + sep + template.body;
    setCaret(ta, offset + firstSectionEnd(template.body), !!opts.focus);
    fireInput(ta);
    return true;
  }

  /* EXTRA: clear the box, but ONLY when it still holds an untouched template.
     Returns false — and leaves the text alone — the moment the student has
     typed into it, so a mis-click on "Remove template" can never cost work. */
  function clear(ta, opts) {
    if (!ta) return false;
    opts = opts || {};
    var cur = ta.value || '';
    if (cur.replace(/\s+/g, '') === '') return true;
    if (!isTemplate(cur)) return false;
    ta.value = '';
    setCaret(ta, 0, !!opts.focus);
    fireInput(ta);
    return true;
  }

  Clinic.templates = {
    all: all,
    get: get,
    forCategory: forCategory,
    isTemplate: isTemplate,
    apply: apply,
    /* extras beyond §10.5, used by new.js */
    appendTo: appendTo,
    clear: clear,
    fenceFor: fenceFor
  };
})(window, document);
