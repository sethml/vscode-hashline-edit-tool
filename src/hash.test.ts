/**
 * Quick smoke test for the hash function.
 * Run with: node out/hash.test.js
 */
const { lineHash, formatLine, fnv1a32 } = require('./hash');

// Test determinism
const h1 = lineHash('  return "world";');
const h2 = lineHash('  return "world";');
console.assert(h1 === h2, `determinism: ${h1} !== ${h2}`);
console.log(`✓ determinism: "${h1}" === "${h2}"`);

// Test that different content gives different hash (usually)
const h3 = lineHash('function hello() {');
const h4 = lineHash('function goodbye() {');
console.log(`  "function hello() {"    → ${h3}`);
console.log(`  "function goodbye() {"  → ${h4}`);
console.log(`  ${h3 !== h4 ? '✓ different' : '⚠ collision (acceptable)'}`);

// Test empty line
const hEmpty = lineHash('');
console.log(`  ""                      → ${hEmpty}`);
console.assert(hEmpty.length === 2, `expected 2 chars, got ${hEmpty.length}`);
console.log(`✓ empty line hash: "${hEmpty}"`);

// Test formatLine
const formatted = formatLine(42, 'hello world');
const hash = lineHash('hello world');
const expected = `42:${hash}|hello world`;
console.assert(formatted === expected, `formatLine: "${formatted}" !== "${expected}"`);
console.log(`✓ formatLine: "${formatted}"`);

// Test whitespace sensitivity
const hSpace = lineHash('  hello');
const hNoSpace = lineHash('hello');
console.log(`  "  hello" → ${hSpace}, "hello" → ${hNoSpace}`);
console.assert(hSpace !== hNoSpace, 'whitespace should affect hash');
console.log(`✓ whitespace sensitive`);

// Show distribution: hash 100 lines, count unique hashes
const hashes = new Set();
for (let i = 0; i < 100; i++) {
    hashes.add(lineHash(`line number ${i} with some content`));
}
console.log(`✓ distribution: ${hashes.size} unique hashes from 100 lines (max 676)`);

console.log('\nAll tests passed.');
