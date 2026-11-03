import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parsers } from 'prettier/plugins/markdown';

function inspectPath(root, target) {
  const local = relative(root, target);
  if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`))
    return 'outside repository';
  let current = root;
  const parts = local.split(sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return 'missing';
    if (stat.isSymbolicLink()) return 'symlink';
    if (!stat.isFile() && !stat.isDirectory()) return 'not a regular file or directory';
    if (stat.isFile() && index < parts.length - 1) return 'missing';
  }
  return null;
}

export function readDocumentation(root) {
  root = resolve(root);
  const paths = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ':(icase)*.md'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  const documents = new Map();
  const violations = [];
  for (const path of [...new Set(paths)].sort()) {
    const target = resolve(root, path);
    const problem = inspectPath(root, target);
    // Deleted tracked documents are checked through their surviving incoming links.
    if (problem === 'missing') continue;
    if (problem) {
      violations.push(`${path} cannot be checked: ${problem}.`);
    } else if (lstatSync(target).isFile()) {
      documents.set(path, readFileSync(target, 'utf8'));
    }
  }
  return { documents, violations };
}

function visit(node, callback) {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

function headingText(node) {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'image') return node.alt ?? '';
  return (node.children ?? []).map(headingText).join('');
}

function collectAnchors(tree) {
  const anchors = new Set();
  const headingSlugs = new Set();
  visit(tree, (node) => {
    if (node.type === 'heading') {
      const base = headingText(node)
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '')
        .replace(/ /gu, '-');
      let slug = base;
      let suffix = 0;
      while (headingSlugs.has(slug)) slug = `${base}-${++suffix}`;
      headingSlugs.add(slug);
      anchors.add(slug);
    }
    if (node.type === 'html') {
      for (const match of node.value.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/giu)) {
        anchors.add(match[1]);
      }
    }
  });
  return anchors;
}

export async function findDocumentationLinkViolations(root, documents) {
  root = resolve(root);
  const parsed = new Map();
  for (const [path, contents] of documents) {
    const tree = await parsers.markdown.parse(contents);
    parsed.set(path, { tree, anchors: collectAnchors(tree) });
  }
  const violations = [];
  for (const [path, { tree }] of parsed) {
    const definitions = new Map();
    visit(tree, (node) => {
      if (node.type === 'definition' && !definitions.has(node.identifier.toLowerCase())) {
        definitions.set(node.identifier.toLowerCase(), node.url);
      }
    });
    visit(tree, (node) => {
      const url =
        node.type === 'link' || node.type === 'image'
          ? node.url
          : node.type === 'linkReference' || node.type === 'imageReference'
            ? definitions.get(node.identifier.toLowerCase())
            : undefined;
      if (url === undefined || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(url)) return;
      const location = `${path}:${node.position.start.line}`;
      const hash = url.indexOf('#');
      let pathname;
      let fragment;
      try {
        pathname = decodeURIComponent((hash < 0 ? url : url.slice(0, hash)).split('?')[0]);
        fragment = hash < 0 ? '' : decodeURIComponent(url.slice(hash + 1));
      } catch {
        violations.push(`${location} has invalid URL encoding: ${url}.`);
        return;
      }
      if (pathname.includes('\0')) {
        violations.push(`${location} has an invalid local path: ${url}.`);
        return;
      }
      const target = pathname
        ? pathname.startsWith('/')
          ? resolve(root, `.${pathname}`)
          : resolve(dirname(resolve(root, path)), pathname)
        : resolve(root, path);
      const problem = inspectPath(root, target);
      if (problem) {
        violations.push(`${location} references ${problem} local target ${url}.`);
        return;
      }
      if (!fragment || !/\.md$/iu.test(target)) return;
      const targetPath = relative(root, target).split(sep).join('/');
      const targetDocument = parsed.get(targetPath);
      if (!targetDocument) {
        violations.push(
          `${location} references a Markdown target outside the checked files: ${url}.`,
        );
      } else if (!targetDocument.anchors.has(fragment)) {
        violations.push(`${location} references missing section ${url}.`);
      }
    });
  }
  return violations;
}
