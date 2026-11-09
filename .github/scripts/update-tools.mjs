// Rebuilds the "Tools we reach for" icon row in profile/README.md from the
// organisation's public repositories. It looks at each repo's languages and its
// dependency files (requirements.txt, pyproject.toml, package.json, Dockerfile, ...)
// and rewrites the block between the TOOLS:START / TOOLS:END markers.
//
// Run locally:  GITHUB_TOKEN=$(gh auth token) node .github/scripts/update-tools.mjs
// Add --dry-run to print the result without touching the README.

import { readFileSync, writeFileSync } from 'node:fs';

const ORG = process.env.ORG || 'Coke-and-Code-Dev';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const README = 'profile/README.md';
const START = '<!-- TOOLS:START -->';
const END = '<!-- TOOLS:END -->';
const DRY_RUN = process.argv.includes('--dry-run');

// ---- Tuning knobs ---------------------------------------------------------
const SKIP_REPOS = new Set(['.github']);   // repos never scanned
const MAX_ICONS = 10;                      // show only the top N
const FILLERS = ['git', 'github'];         // used only if fewer than MAX_ICONS are detected
const NEVER = new Set([]);                 // icon ids to hide even if detected
const MIN_LANGUAGE_SHARE = 0.01;           // a language must be >=1% of some repo
const PER_LINE = 10;

// When trimming to MAX_ICONS, libraries and frameworks win over build/test/CI tooling.
const RANK = {
  pytorch: 0, tensorflow: 0, sklearn: 0, opencv: 0,
  fastapi: 1, flask: 1, django: 1, express: 1, nestjs: 1, react: 1, nextjs: 1, vue: 1,
  nuxtjs: 1, svelte: 1, angular: 1, solidjs: 1, astro: 1, threejs: 1, d3: 1, electron: 1, tauri: 1,
  tailwind: 3, bootstrap: 3, materialui: 3,
  vite: 4, webpack: 4, jest: 4, vitest: 4, cypress: 4, selenium: 4, githubactions: 4,
};
const rank = (id) => RANK[id] ?? 2; // databases, cloud, docker etc. sit in the middle

// GitHub language name -> skillicons id
const LANGUAGES = {
  Python: 'py', 'Jupyter Notebook': 'py', TypeScript: 'ts', JavaScript: 'js',
  HTML: 'html', CSS: 'css', SCSS: 'sass', Sass: 'sass', Less: 'less',
  Shell: 'bash', PowerShell: 'powershell', Dockerfile: 'docker', R: 'r',
  Java: 'java', Kotlin: 'kotlin', 'C++': 'cpp', C: 'c', 'C#': 'cs', Go: 'go',
  Rust: 'rust', Swift: 'swift', Dart: 'dart', PHP: 'php', Ruby: 'ruby',
  MATLAB: 'matlab', TeX: 'latex', Vue: 'vue', Svelte: 'svelte', Scala: 'scala',
  Haskell: 'haskell', Lua: 'lua', Solidity: 'solidity', Astro: 'astro',
};

// Python package name -> skillicons id
const PY_PACKAGES = {
  torch: 'pytorch', pytorch: 'pytorch', tensorflow: 'tensorflow', keras: 'tensorflow',
  'scikit-learn': 'sklearn', sklearn: 'sklearn', fastapi: 'fastapi', flask: 'flask',
  django: 'django', 'opencv-python': 'opencv', 'opencv-python-headless': 'opencv',
  'opencv-contrib-python': 'opencv', selenium: 'selenium', 'firebase-admin': 'firebase',
  psycopg2: 'postgres', 'psycopg2-binary': 'postgres', psycopg: 'postgres',
  pymongo: 'mongodb', redis: 'redis', graphene: 'graphql', strawberry: 'graphql',
  'strawberry-graphql': 'graphql', 'supabase': 'supabase', kafka: 'kafka',
  'kafka-python': 'kafka', pika: 'rabbitmq', boto3: 'aws', anaconda: 'anaconda',
};

// npm package name -> skillicons id
const JS_PACKAGES = {
  react: 'react', next: 'nextjs', vue: 'vue', nuxt: 'nuxtjs', svelte: 'svelte',
  '@sveltejs/kit': 'svelte', '@angular/core': 'angular', 'solid-js': 'solidjs',
  astro: 'astro', tailwindcss: 'tailwind', bootstrap: 'bootstrap', vite: 'vite',
  express: 'express', '@nestjs/core': 'nestjs', three: 'threejs', d3: 'd3',
  electron: 'electron', redux: 'redux', '@reduxjs/toolkit': 'redux', jest: 'jest',
  vitest: 'vitest', cypress: 'cypress', webpack: 'webpack', '@mui/material': 'materialui',
  graphql: 'graphql', prisma: 'prisma', '@prisma/client': 'prisma', firebase: 'firebase',
  '@supabase/supabase-js': 'supabase', jquery: 'jquery', p5: 'p5js', htmx: 'htmx',
  'htmx.org': 'htmx', '@tauri-apps/api': 'tauri',
};

// File present anywhere in the repo -> skillicons id
const FILE_MARKERS = [
  [/(^|\/)Dockerfile$|(^|\/)(docker-)?compose\.ya?ml$/, 'docker'],
  [/^\.github\/workflows\/[^/]+\.ya?ml$/, 'githubactions'],
  [/(^|\/)firebase\.json$/, 'firebase'],
  [/(^|\/)vercel\.json$/, 'vercel'],
  [/(^|\/)netlify\.toml$/, 'netlify'],
  [/(^|\/)wrangler\.toml$/, 'cloudflare'],
  [/(^|\/)environment\.ya?ml$/, 'anaconda'],
  [/\.tf$/, 'terraform'],
];

// Display names for the image's alt text
const NAMES = {
  py: 'Python', ts: 'TypeScript', js: 'JavaScript', html: 'HTML', css: 'CSS',
  sklearn: 'scikit-learn', pytorch: 'PyTorch', tensorflow: 'TensorFlow',
  fastapi: 'FastAPI', react: 'React', nextjs: 'Next.js', nodejs: 'Node.js',
  githubactions: 'GitHub Actions', github: 'GitHub', git: 'Git', opencv: 'OpenCV',
  postgres: 'PostgreSQL', mongodb: 'MongoDB', threejs: 'three.js', materialui: 'Material UI',
  tailwind: 'Tailwind CSS', aws: 'AWS', gcp: 'Google Cloud', cpp: 'C++', cs: 'C#',
};
const name = (id) => NAMES[id] || id.charAt(0).toUpperCase() + id.slice(1);

// ---------------------------------------------------------------------------
const IGNORED_DIRS = /(^|\/)(node_modules|vendor|venv|\.venv|site-packages|dist|build)\//;
const PY_MANIFEST = /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|Pipfile|environment\.ya?ml)$/;
const JS_MANIFEST = /(^|\/)package\.json$/;

async function api(path, { raw = false } = {}) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'org-profile-tools-updater',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (res.status === 404 || res.status === 409) return null; // missing / empty repo
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return raw ? res.text() : res.json();
}

async function listRepos() {
  const repos = [];
  for (let page = 1; ; page++) {
    const batch = await api(`orgs/${ORG}/repos?type=public&per_page=100&page=${page}`);
    if (!batch?.length) break;
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.filter((r) => !r.fork && !r.archived && !r.private && !SKIP_REPOS.has(r.name));
}

function hasPackage(text, pkg) {
  const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|["'\\s,\\[])${esc}(\\s*[<>=!~\\[;,"'\\s]|$)`, 'im').test(text);
}

async function scanRepo(repo) {
  const found = new Set();
  const languageBytes = {};

  const langs = (await api(`repos/${ORG}/${repo.name}/languages`)) || {};
  const total = Object.values(langs).reduce((a, b) => a + b, 0) || 1;
  for (const [lang, bytes] of Object.entries(langs)) {
    const id = LANGUAGES[lang];
    if (id && bytes / total >= MIN_LANGUAGE_SHARE) languageBytes[id] = (languageBytes[id] || 0) + bytes;
  }

  const tree = await api(`repos/${ORG}/${repo.name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`);
  const files = (tree?.tree || []).filter((t) => t.type === 'blob' && !IGNORED_DIRS.test(t.path)).map((t) => t.path);

  for (const f of files) for (const [re, id] of FILE_MARKERS) if (re.test(f)) found.add(id);

  const manifests = files.filter((f) => PY_MANIFEST.test(f) || JS_MANIFEST.test(f)).slice(0, 40);
  for (const f of manifests) {
    const text = await api(`repos/${ORG}/${repo.name}/contents/${f.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(repo.default_branch)}`, { raw: true });
    if (!text) continue;
    if (JS_MANIFEST.test(f)) {
      let pkg;
      try { pkg = JSON.parse(text); } catch { continue; }
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      for (const dep of Object.keys(deps)) if (JS_PACKAGES[dep]) found.add(JS_PACKAGES[dep]);
    } else {
      for (const [dep, id] of Object.entries(PY_PACKAGES)) if (hasPackage(text, dep)) found.add(id);
    }
  }
  return { languageBytes, found };
}

async function main() {
  const repos = await listRepos();
  const languageBytes = {};
  const toolRepoCount = {};

  for (const repo of repos) {
    const r = await scanRepo(repo);
    for (const [id, b] of Object.entries(r.languageBytes)) languageBytes[id] = (languageBytes[id] || 0) + b;
    for (const id of r.found) toolRepoCount[id] = (toolRepoCount[id] || 0) + 1;
    console.log(`${repo.name}: ${[...Object.keys(r.languageBytes), ...r.found].join(', ') || '(nothing detected)'}`);
  }

  const langs = Object.entries(languageBytes).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const tools = Object.entries(toolRepoCount)
    .filter(([id]) => !langs.includes(id))
    .sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
  const ids = [...new Set([...langs, ...tools, ...FILLERS])].filter((id) => !NEVER.has(id)).slice(0, MAX_ICONS);

  // Spread icons evenly over the fewest rows, so a short last row isn't left hanging.
  const rows = Math.ceil(ids.length / PER_LINE);
  const perLine = Math.ceil(ids.length / rows);
  const width = perLine * 56;
  const block = [
    START,
    '<p align="center">',
    `  <img src="https://skillicons.dev/icons?i=${ids.join(',')}&perline=${perLine}" alt="${ids.map(name).join(', ')}" width="${width}">`,
    '</p>',
    END,
  ].join('\n');

  console.log(`\nIcons: ${ids.join(', ')}`);
  if (DRY_RUN) return console.log(`\n${block}`);

  const readme = readFileSync(README, 'utf8');
  const s = readme.indexOf(START), e = readme.indexOf(END);
  if (s === -1 || e === -1) throw new Error(`Markers ${START} / ${END} not found in ${README}`);
  const updated = readme.slice(0, s) + block + readme.slice(e + END.length);
  if (updated === readme) return console.log('README already up to date.');
  writeFileSync(README, updated);
  console.log('README updated.');
}

main().catch((err) => { console.error(err); process.exit(1); });
