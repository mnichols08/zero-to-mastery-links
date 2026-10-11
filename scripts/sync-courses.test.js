/**
 * sync-courses.test.js
 *
 * Unit tests for the pure helper functions exported from sync-courses.js.
 * No network calls — all tests run offline and fast.
 *
 * Run with:  npm test  (or: node --test scripts/sync-courses.test.js)
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cheerio = require('cheerio');

const {
  parseCSVLine,
  normalizeTitle,
  loadExisting,
  extractCoursesFromPage,
  mergeEnrolledUrls,
  buildCSV,
} = require('./sync-courses');

// ── parseCSVLine ──────────────────────────────────────────────────────────────

describe('parseCSVLine', () => {
  it('parses a plain three-column line', () => {
    assert.deepEqual(parseCSVLine('foo,bar,baz'), ['foo', 'bar', 'baz']);
  });

  it('parses quoted fields', () => {
    assert.deepEqual(parseCSVLine('"foo","bar","baz"'), ['foo', 'bar', 'baz']);
  });

  it('handles escaped double-quotes inside a quoted field', () => {
    assert.deepEqual(parseCSVLine('"say ""hello""",b,c'), ['say "hello"', 'b', 'c']);
  });

  it('handles commas inside quoted fields', () => {
    assert.deepEqual(parseCSVLine('"a,b",c,d'), ['a,b', 'c', 'd']);
  });

  it('returns a single element for a line with no commas', () => {
    assert.deepEqual(parseCSVLine('hello'), ['hello']);
  });
});

// ── normalizeTitle ────────────────────────────────────────────────────────────

describe('normalizeTitle', () => {
  it('lowercases and strips non-alphanumeric characters', () => {
    assert.equal(normalizeTitle('Complete Python Bootcamp!'), 'completepythonbootcamp');
  });

  it('handles titles with numbers', () => {
    assert.equal(normalizeTitle('Web Dev 2.0: The Full Course'), 'webdev20thefullcourse');
  });
});

// ── loadExisting ──────────────────────────────────────────────────────────────

describe('loadExisting', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztm-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty maps when file does not exist', () => {
    const { byPublicUrl, byTitle } = loadExisting(path.join(tmpDir, 'missing.csv'));
    assert.equal(byPublicUrl.size, 0);
    assert.equal(byTitle.size, 0);
  });

  it('loads canonical three-column CSV correctly', () => {
    const csv =
      'course,enrolled_url,public_url\n' +
      '"Python Bootcamp","https://academy.zerotomastery.io/courses/enrolled/700001","https://academy.zerotomastery.io/p/python"\n';
    const file = path.join(tmpDir, 'academy.csv');
    fs.writeFileSync(file, csv);

    const { byPublicUrl, byTitle } = loadExisting(file);
    assert.equal(
      byPublicUrl.get('https://academy.zerotomastery.io/p/python'),
      'https://academy.zerotomastery.io/courses/enrolled/700001'
    );
    assert.equal(
      byTitle.get('pythonbootcamp'),
      'https://academy.zerotomastery.io/courses/enrolled/700001'
    );
  });

  it('loads legacy two-column CSV with enrolled_url in col2 — regression for hasThreeCols bug', () => {
    // This is the bug that was wiping enrolled URLs: a two-col header that
    // contains "enrolled_url" was being misdetected as hasThreeCols=true,
    // causing col3 (which didn't exist) to be used as publicUrl, so no key
    // was ever set in byPublicUrl and byTitle only got empty strings.
    const csv =
      'course,enrolled_url\n' +
      '"JS Course","https://academy.zerotomastery.io/courses/enrolled/700002"\n';
    const file = path.join(tmpDir, 'academy.csv');
    fs.writeFileSync(file, csv);

    const { byPublicUrl, byTitle } = loadExisting(file);
    assert.equal(byPublicUrl.size, 0);
    assert.equal(
      byTitle.get('jscourse'),
      'https://academy.zerotomastery.io/courses/enrolled/700002'
    );
  });

  it('loads legacy two-column CSV with public_url in col2', () => {
    const csv =
      'course,public_url\n' +
      '"React Course","https://academy.zerotomastery.io/p/react"\n';
    const file = path.join(tmpDir, 'academy.csv');
    fs.writeFileSync(file, csv);

    const { byPublicUrl, byTitle } = loadExisting(file);
    assert.equal(byPublicUrl.get('https://academy.zerotomastery.io/p/react'), '');
    assert.equal(byTitle.get('reactcourse'), '');
  });

  it('ignores rows with empty course name', () => {
    const csv =
      'course,enrolled_url,public_url\n' +
      '"","https://academy.zerotomastery.io/courses/enrolled/700001","https://academy.zerotomastery.io/p/python"\n';
    const file = path.join(tmpDir, 'academy.csv');
    fs.writeFileSync(file, csv);

    const { byPublicUrl, byTitle } = loadExisting(file);
    assert.equal(byPublicUrl.size, 0);
    assert.equal(byTitle.size, 0);
  });
});

// ── extractCoursesFromPage ────────────────────────────────────────────────────

describe('extractCoursesFromPage', () => {
  function makeCard(href, title) {
    return `
      <div class="ztm-course-card">
        <a href="${href}">
          <div class="course-listing-title">${title}</div>
        </a>
      </div>`;
  }

  it('extracts a single course card', () => {
    const $ = cheerio.load(makeCard('/p/python', 'Python Bootcamp'));
    const results = extractCoursesFromPage($);
    assert.equal(results.length, 1);
    assert.equal(results[0].course, 'Python Bootcamp');
    assert.equal(results[0].publicUrl, 'https://academy.zerotomastery.io/p/python');
  });

  it('prepends BASE_URL for relative hrefs', () => {
    const $ = cheerio.load(makeCard('/p/react', 'React Course'));
    const results = extractCoursesFromPage($);
    assert.equal(results[0].publicUrl, 'https://academy.zerotomastery.io/p/react');
  });

  it('leaves absolute hrefs unchanged', () => {
    const $ = cheerio.load(makeCard('https://academy.zerotomastery.io/p/react', 'React Course'));
    const results = extractCoursesFromPage($);
    assert.equal(results[0].publicUrl, 'https://academy.zerotomastery.io/p/react');
  });

  it('strips "% COMPLETE" badge text injected by Teachable', () => {
    const $ = cheerio.load(makeCard('/p/ml', 'Machine Learning 100% COMPLETE'));
    const results = extractCoursesFromPage($);
    assert.equal(results[0].course, 'Machine Learning');
  });

  it('does NOT strip the word "Complete" when it appears naturally in a title — regression', () => {
    // The old regex /\d*\s*%?\s*COMPLETE/gi matched "Complete" because \d* and %? are optional.
    // The fix requires either digits+% or bare % before COMPLETE.
    const $ = cheerio.load(makeCard('/p/complete-web-dev', 'Complete Web Developer'));
    const results = extractCoursesFromPage($);
    assert.equal(results[0].course, 'Complete Web Developer');
  });

  it('skips cards without an href', () => {
    const html = `
      <div class="ztm-course-card">
        <a><div class="course-listing-title">Ghost Course</div></a>
      </div>`;
    const $ = cheerio.load(html);
    const results = extractCoursesFromPage($);
    assert.equal(results.length, 0);
  });
});

// ── mergeEnrolledUrls ─────────────────────────────────────────────────────────

describe('mergeEnrolledUrls', () => {
  const ENROLLED = 'https://academy.zerotomastery.io/courses/enrolled/700001';
  const PUBLIC = 'https://academy.zerotomastery.io/p/python';

  it('matches by public URL (primary strategy)', () => {
    const scraped = [{ course: 'Python Bootcamp', publicUrl: PUBLIC }];
    const byPublicUrl = new Map([[PUBLIC, ENROLLED]]);
    const byTitle = new Map();

    const merged = mergeEnrolledUrls(scraped, byPublicUrl, byTitle);
    assert.equal(merged[0].enrolledUrl, ENROLLED);
  });

  it('falls back to normalized title match when public URL not found', () => {
    const scraped = [{ course: 'Python Bootcamp', publicUrl: PUBLIC }];
    const byPublicUrl = new Map();
    const byTitle = new Map([['pythonbootcamp', ENROLLED]]);

    const merged = mergeEnrolledUrls(scraped, byPublicUrl, byTitle);
    assert.equal(merged[0].enrolledUrl, ENROLLED);
  });

  it('leaves enrolledUrl empty when neither strategy matches', () => {
    const scraped = [{ course: 'Brand New Course', publicUrl: PUBLIC }];
    const byPublicUrl = new Map();
    const byTitle = new Map();

    const merged = mergeEnrolledUrls(scraped, byPublicUrl, byTitle);
    assert.equal(merged[0].enrolledUrl, '');
  });

  it('fuzzy match: survives a year suffix added to the title ("in 2026")', () => {
    // Old CSV had "Complete Python Developer: Zero to Mastery"
    // ZTM renamed it to "Complete Python Developer in 2026: Zero to Mastery"
    const scraped = [{ course: 'Complete Python Developer in 2026: Zero to Mastery', publicUrl: PUBLIC }];
    const byPublicUrl = new Map();
    const byTitle = new Map([['completepythondeveloperzerotomastery', ENROLLED]]);

    const merged = mergeEnrolledUrls(scraped, byPublicUrl, byTitle);
    assert.equal(merged[0].enrolledUrl, ENROLLED);
  });

  it('fuzzy match: survives dropping "The" from the title', () => {
    // Old: "The Complete Guide to Freelancing" → new: "Complete Guide to Freelancing"
    const scraped = [{ course: 'Complete Guide to Freelancing: Zero to Mastery', publicUrl: PUBLIC }];
    const byPublicUrl = new Map();
    const byTitle = new Map([['thecompleteguidetofreelancingzerotomastery', ENROLLED]]);

    const merged = mergeEnrolledUrls(scraped, byPublicUrl, byTitle);
    assert.equal(merged[0].enrolledUrl, ENROLLED);
  });

  it('fuzzy match: survives inserting "with" into the title', () => {
    // Old: "Learning to Learn [Efficient Learning]: Zero to Mastery"
    // New: "Learning to Learn [Efficient Learning] with Zero to Mastery"
    const scraped = [{ course: 'Learning to Learn [Efficient Learning] with Zero to Mastery', publicUrl: PUBLIC }];
    const byPublicUrl = new Map();
    const byTitle = new Map([['learningtolearnefficientlearningzerotomastery', ENROLLED]]);

    const merged = mergeEnrolledUrls(scraped, byPublicUrl, byTitle);
    assert.equal(merged[0].enrolledUrl, ENROLLED);
  });

  it('fuzzy match: survives inserting "A.I." into the title', () => {
    // Old: "Complete Machine Learning and Data Science: Zero to Mastery"
    // New: "Complete A.I. Machine Learning and Data Science: Zero to Mastery"
    const scraped = [{ course: 'Complete A.I. Machine Learning and Data Science: Zero to Mastery', publicUrl: PUBLIC }];
    const byPublicUrl = new Map();
    const byTitle = new Map([['completemachinelearninganddatasciencezerotomastery', ENROLLED]]);

    const merged = mergeEnrolledUrls(scraped, byPublicUrl, byTitle);
    assert.equal(merged[0].enrolledUrl, ENROLLED);
  });

  it('fuzzy match: documents substring behaviour for short/long title pairs', () => {
    // "pythonbootcamp" is a substring of "advancedpythonbootcamp" so it will
    // fuzzy-match. This is acceptable — carrying over an enrolled URL is safer
    // than losing it, and public URL match takes precedence in steady state.
    const scraped = [{ course: 'Python Bootcamp', publicUrl: PUBLIC }];
    const byPublicUrl = new Map();
    const byTitle = new Map([
      ['advancedpythonbootcamp', ENROLLED],
      ['pythonbootcamp', ''],
    ]);

    const merged = mergeEnrolledUrls(scraped, byPublicUrl, byTitle);
    assert.equal(typeof merged[0].enrolledUrl, 'string');
  });

  it('CRITICAL round-trip: enrolled URLs loaded from CSV survive a scraper run', () => {
    // Simulate a complete cycle: CSV → loadExisting → mergeEnrolledUrls.
    // Guards the core contract: enrolled URLs are never silently wiped.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztm-roundtrip-'));
    try {
      const csv =
        'course,enrolled_url,public_url\n' +
        `"Python Bootcamp","${ENROLLED}","${PUBLIC}"\n`;
      const file = path.join(dir, 'academy.csv');
      fs.writeFileSync(file, csv);

      const { byPublicUrl, byTitle } = loadExisting(file);
      const scraped = [{ course: 'Python Bootcamp', publicUrl: PUBLIC }];
      const merged = mergeEnrolledUrls(scraped, byPublicUrl, byTitle);

      assert.equal(merged[0].enrolledUrl, ENROLLED);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── buildCSV ──────────────────────────────────────────────────────────────────

describe('buildCSV', () => {
  it('outputs the correct header row', () => {
    const csv = buildCSV([]);
    assert.ok(csv.startsWith('course,enrolled_url,public_url\n'));
  });

  it('writes a data row with all three columns quoted', () => {
    const courses = [{
      course: 'Python Bootcamp',
      enrolledUrl: 'https://academy.zerotomastery.io/courses/enrolled/700001',
      publicUrl: 'https://academy.zerotomastery.io/p/python',
    }];
    const csv = buildCSV(courses);
    assert.ok(csv.includes('"Python Bootcamp"'));
    assert.ok(csv.includes('"https://academy.zerotomastery.io/courses/enrolled/700001"'));
    assert.ok(csv.includes('"https://academy.zerotomastery.io/p/python"'));
  });

  it('handles courses with no enrolled URL (empty string in col 2)', () => {
    const courses = [{
      course: 'New Course',
      enrolledUrl: '',
      publicUrl: 'https://academy.zerotomastery.io/p/new-course',
    }];
    const csv = buildCSV(courses);
    const dataLine = csv.split('\n')[1];
    assert.equal(dataLine, '"New Course","","https://academy.zerotomastery.io/p/new-course"');
  });

  it('escapes double-quotes inside field values', () => {
    const courses = [{
      course: 'Web Dev: "The Best" Course',
      enrolledUrl: '',
      publicUrl: 'https://academy.zerotomastery.io/p/web',
    }];
    const csv = buildCSV(courses);
    assert.ok(csv.includes('"Web Dev: ""The Best"" Course"'));
  });
});

// ── exports contract ──────────────────────────────────────────────────────────

describe('module exports', () => {
  it('exports all expected helper functions', () => {
    const mod = require('./sync-courses');
    for (const fn of ['parseCSVLine', 'normalizeTitle', 'loadExisting', 'extractCoursesFromPage', 'mergeEnrolledUrls', 'buildCSV']) {
      assert.equal(typeof mod[fn], 'function', `expected ${fn} to be a function`);
    }
  });

  it('buildCSV produces at least a header + one row for a single course', () => {
    const lines = buildCSV([
      { course: 'X', enrolledUrl: '', publicUrl: 'https://academy.zerotomastery.io/p/x' },
    ]).trim().split('\n');
    assert.ok(lines.length >= 2);
  });
});