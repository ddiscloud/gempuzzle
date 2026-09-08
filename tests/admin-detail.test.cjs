const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('function openAdminDetail(');
const end = html.indexOf('\nfunction closeAdminDetail(', start);
assert(start >= 0 && end > start, 'Load the actual detail renderer from index.html');
const renderer = new vm.Script(html.slice(start, end), { filename: 'admin-detail-from-index.html' });
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// This DOM double records text nodes separately from HTML assignment.
// It intentionally does not execute event handlers or connect to Firebase.
class Node {
  constructor(tagName = 'DIV', nodeType = 1, text = '') {
    this.tagName = tagName;
    this.nodeType = nodeType;
    this.childNodes = [];
    this.data = text;
    this.rawHtml = null;
    this.classList = { add() {} };
  }
  set textContent(value) {
    this.childNodes = [];
    this.data = String(value);
    this.rawHtml = null;
  }
  get textContent() { return this.data + this.childNodes.map(node => node.textContent).join(''); }
  set innerHTML(value) {
    this.childNodes = [];
    this.data = '';
    this.rawHtml = String(value);
  }
  get innerHTML() {
    return this.rawHtml ?? (escape(this.data) + this.childNodes.map(node => node.serialize()).join(''));
  }
  appendChild(node) { this.childNodes.push(node); return node; }
  serialize() {
    if (this.nodeType === 3) return escape(this.data);
    return this.tagName === 'BR' ? '<br>' : '<div>' + this.innerHTML + '</div>';
  }
}

function makeView() {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const context = vm.createContext({
    _adCurrent: null,
    drawStageThumb() {},
    document: {
      getElementById: get,
      createElement: tag => new Node(tag.toUpperCase()),
      createTextNode: text => new Node('', 3, String(text))
    }
  });
  renderer.runInContext(context);
  return { get, render: sub => context.openAdminDetail(sub) };
}
const submission = values => ({name: '테스트', nickname: '테스터', size: 2, grid: [[1, 1], [2, 0]], ...values});

test('nickname markup is displayed literally, with no user-created HTML element', () => {
  const view = makeView();
  const nickname = '<img src=x onerror="window.untrustedInputRan=true">';
  view.render(submission({ nickname }));
  const info = view.get('adDetailInfo');
  assert(!info.innerHTML.includes('<img'));
  assert.equal(info.childNodes[0]?.textContent, '제작: ' + nickname);
  assert(info.innerHTML.includes('&lt;img'));
});

test('an unvalidated size is also text, not HTML', () => {
  const view = makeView();
  const size = '<svg onload="window.untrustedInputRan=true">';
  view.render(submission({ size }));
  const info = view.get('adDetailInfo');
  assert(!info.innerHTML.includes('<svg'));
  assert.equal(info.childNodes[2]?.textContent, '크기: ' + size + '×' + size);
  assert(info.childNodes.every(node => node.nodeType === 3 || node.tagName === 'BR'));
});

test('normal metadata retains five lines and its calculated statistics', () => {
  const view = makeView();
  view.render(submission({ name: '작은 그림', nickname: '한글 & "기호" <문자>' }));
  const info = view.get('adDetailInfo');
  assert.deepEqual(info.childNodes.filter(node => node.nodeType === 3).map(node => node.textContent), [
    '제작: 한글 & "기호" <문자>', '크기: 2×2', '색: 2개', '칸: 3개', '최다색 비율: 67%'
  ]);
  assert.equal(info.childNodes.filter(node => node.tagName === 'BR').length, 4);
  assert.equal(view.get('adDetailTitle').textContent, '작은 그림');
});

test('opening another submission replaces the previous detail', () => {
  const view = makeView();
  view.render(submission({ nickname: '이전 제작자' }));
  view.render(submission({ nickname: '새 제작자' }));
  const info = view.get('adDetailInfo');
  assert.equal(info.childNodes.length, 9);
  assert(info.textContent.includes('새 제작자'));
  assert(!info.textContent.includes('이전 제작자'));
});
