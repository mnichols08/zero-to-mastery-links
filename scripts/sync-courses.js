/**
 * sync-courses.js
 *
 * Keeps academy.csv up to date with three columns:
 *
 *   course       — course title (scraper keeps this fresh)
 *   enrolled_url — https://academy.zerotomastery.io/courses/enrolled/XXXXXX
 *                  (manually added once; never overwritten by this script)
 *   public_url   — https://academy.zerotomastery.io/p/course-slug
 *                  (always populated by scraper; fallback for non-members)
 *
 * Usage:
 *   node scripts/sync-courses.js
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const BASE = "https://academy.zerotomastery.io";
const OUTPUT = path.resolve(__dirname, "..", "academy.csv");
const DELAY_MS = 400;

// Minimum number of courses we expect to find. If scraping returns fewer than this, something is broken and we abort rather than overwrite the CSV.
const MIN_EXPECTED_COURSES = 50;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CSV helpers ───────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const fields = [];
  let cur = "",
    inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function q(s) {
  return `"${(s || "").replace(/"/g, '""')}"`;
}

function normalizeTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Load existing CSV → { byPublicUrl, byTitle }
// Supports legacy two-col format (course, enrolled_url) and canonical three-col format.
function loadExisting(filePath) {
  const byPublicUrl = new Map();
  const byTitle = new Map();

  if (!fs.existsSync(filePath)) return { byPublicUrl, byTitle };

  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  if (lines.length < 2) return { byPublicUrl, byTitle };

  const headerCols = parseCSVLine(lines[0].toLowerCase());
  const hasThreeCols = headerCols.length >= 3;

  for (const line of lines.slice(1)) {
    const cols = parseCSVLine(line);
    const course = (cols[0] || "").trim();
    const col2 = (cols[1] || "").trim();
    const col3 = (cols[2] || "").trim();

    if (!course) continue;

    let enrolledUrl = "";
    let publicUrl = "";

    if (hasThreeCols) {
      if (col2.includes("/enrolled/")) {
        enrolledUrl = col2;
        publicUrl = col3;
      } else if (col3.includes("/enrolled/")) {
        enrolledUrl = col3;
        publicUrl = col2;
      } else {
        publicUrl = col2;
      }
    } else {
      if (col2.includes("/enrolled/")) enrolledUrl = col2;
      else if (col2.startsWith("http")) publicUrl = col2;
    }

    if (publicUrl) byPublicUrl.set(publicUrl, enrolledUrl);
    byTitle.set(normalizeTitle(course), enrolledUrl);
  }

  return { byPublicUrl, byTitle };
}

// Extract course cards from a loaded cheerio page
function extractCoursesFromPage($) {
  const results = [];
  $(".ztm-course-card").each((_, el) => {
    const link = $(el).find("a").first();
    const href = link.attr("href");
    if (!href) return;

    let title =
      $(el).find(".course-listing-title").first().text().trim() ||
      link.text().replace(/\s+/g, " ").trim();
    title = title
      .replace(/(\d+\s*%\s*COMPLETE|\s*%\s*COMPLETE)/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!title || title.length < 3) return;

    const publicUrl = href.startsWith("http") ? href : BASE + href;
    results.push({ course: title, publicUrl });
  });
  return results;
}

// Strip filler tokens from a *raw* (pre-normalise) title so that fuzzy
// matching survives ZTM renames that insert/remove words like "in 2026",
// "with", "The", "A.I.", etc.  Must be called before normalizeTitle so
// that word boundaries are still intact.
function stripFillerRaw(title) {
  return title
    .replace(/\bin\s+\d{4}\b/gi, "") // "in 2026"
    .replace(/\bA\.I\./gi, "") // "A.I."
    .replace(/\bwith\b/gi, "")
    .replace(/\bthe\b/gi, "");
}

// Fuzzy title match: returns the enrolled URL from byTitle whose key is a
// substring of `norm` or vice-versa. Handles renames like adding "in 2026",
// "with Zero to Mastery", "A.I.", dropping "The", etc.
// `norm` is already normalizeTitle()'d; we re-derive the filler-stripped
// version from the raw title passed as the second argument.
function fuzzyTitleMatch(rawTitle, byTitle, norm) {
  const normF = normalizeTitle(stripFillerRaw(rawTitle));
  for (const [key, enrolledUrl] of byTitle) {
    if (!enrolledUrl) continue; // skip entries with no enrolled URL
    if (
      normF.includes(key) ||
      key.includes(normF) ||
      norm.includes(key) ||
      key.includes(norm)
    )
      return enrolledUrl;
  }
  return "";
}

// Merge scraped courses with existing enrolled URLs
function mergeEnrolledUrls(scrapedCourses, byPublicUrl, byTitle) {
  return scrapedCourses.map((c) => {
    let enrolledUrl = "";
    const norm = normalizeTitle(c.course);
    if (byPublicUrl.has(c.publicUrl)) {
      enrolledUrl = byPublicUrl.get(c.publicUrl);
    } else {
      // Exact title match first, then fuzzy substring match as fallback
      enrolledUrl =
        byTitle.get(norm) || fuzzyTitleMatch(c.course, byTitle, norm);
    }
    return { ...c, enrolledUrl };
  });
}

// Serialise courses to CSV string
function buildCSV(courses) {
  return (
    [
      "course,enrolled_url,public_url",
      ...courses.map(
        (c) => `${q(c.course)},${q(c.enrolledUrl)},${q(c.publicUrl)}`,
      ),
    ].join("\n") + "\n"
  );
}

// ── Scraper ───────────────────────────────────────────────────────────────────

async function fetchHTML(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function getNextPage($) {
  let next = null;
  $("a").each((_, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr("href");
    if (!href) return;
    if (text.includes("Next") || $(el).attr("rel") === "next") {
      next = href.startsWith("http") ? href : BASE + href;
    }
  });
  return next;
}

async function getCategories() {
  const html = await fetchHTML(`${BASE}/courses`);
  const $ = cheerio.load(html);
  const categories = [];
  $('a[href*="/courses/category/"]').each((_, el) => {
    const cls = $(el).attr("class") || "";
    if (cls.includes("navbar-link")) return;
    const href = $(el).attr("href");
    const url = href.startsWith("http") ? href : BASE + href;
    const label = $(el).text().replace(/\s+/g, " ").trim();
    if (!categories.find((c) => c.url === url)) categories.push({ label, url });
  });
  return categories;
}

async function scrapeCategory(category) {
  const courses = [];
  let pageUrl = category.url;
  let pageNum = 1;
  while (pageUrl) {
    if (pageNum > 1) await sleep(DELAY_MS);
    const html = await fetchHTML(pageUrl);
    const $ = cheerio.load(html);
    const found = extractCoursesFromPage($);
    courses.push(...found);
    process.stdout.write(`    page ${pageNum}: ${found.length} courses\n`);
    pageUrl = getNextPage($);
    pageNum++;
    if (pageNum > 30) {
      console.warn("    ⚠ hit page limit");
      break;
    }
  }
  return courses;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const { byPublicUrl, byTitle } = loadExisting(OUTPUT);
  console.log(
    `Loaded ${byPublicUrl.size} public-URL mappings, ${byTitle.size} title mappings.\n`,
  );

  console.log("Step 1: Discovering categories...");
  const categories = await getCategories();
  console.log(`  Found ${categories.length} categories\n`);

  if (categories.length === 0) {
    throw new Error(
      "No categories found — the page structure may have changed. Aborting to protect academy.csv.",
    );
  }

  const allCourses = [];
  for (const cat of categories) {
    console.log(`Scraping "${cat.label}"...`);
    await sleep(DELAY_MS);
    allCourses.push(...(await scrapeCategory(cat)));
    console.log();
  }

  // Deduplicate by publicUrl
  const seen = new Set();
  const unique = allCourses.filter((c) => {
    if (seen.has(c.publicUrl)) return false;
    seen.add(c.publicUrl);
    return true;
  });

  // Safety check — abort if we got suspiciously few courses
  if (unique.length < MIN_EXPECTED_COURSES) {
    throw new Error(
      `Only found ${unique.length} courses (expected at least ${MIN_EXPECTED_COURSES}). ` +
        `Selectors may be broken. Aborting to protect academy.csv.`,
    );
  }

  // Preserve scrape order (category by category) so downstream consumers
  // aren't affected by row reordering between runs.
  const merged = mergeEnrolledUrls(unique, byPublicUrl, byTitle);
  const withEnrolled = merged.filter((c) => c.enrolledUrl).length;
  const withoutEnrolled = merged.filter((c) => !c.enrolledUrl).length;

  fs.writeFileSync(OUTPUT, buildCSV(merged), "utf8");

  console.log(`✓ Done — ${merged.length} courses`);
  console.log(`  ${withEnrolled} have an enrolled URL`);
  if (withoutEnrolled > 0) {
    console.log(
      `  ${withoutEnrolled} still need an enrolled URL (new courses?):`,
    );
    merged
      .filter((c) => !c.enrolledUrl)
      .forEach((c) => console.log(`    - ${c.course}`));
  }
}

// ── Exports (for tests) ───────────────────────────────────────────────────────
module.exports = {
  parseCSVLine,
  normalizeTitle,
  loadExisting,
  extractCoursesFromPage,
  mergeEnrolledUrls,
  buildCSV,
};

// Only run when executed directly (node scripts/sync-courses.js), not when required by Jest.
if (require.main === module) {
  run().catch((err) => {
    console.error("\n✗ Aborted:", err.message);
    process.exit(1);
  });
}
