// The kit's extra 9 x 9 icons (worn places, conditions), drawn here as rows of letters: # = bone, . = empty.
// Writes art/ui/kit/plain/icon_<name>.png. Run: node tools/gen_ui_icons.js
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const BONE = [231, 221, 194];
const ICONS = {
  helm: [
    '.........',
    '..#####..',
    '.#######.',
    '#########',
    '#########',
    '###...###',
    '##.....##',
    '##.....##',
    '.........'],
  pants: [
    '.#######.',
    '.#######.',
    '.###.###.',
    '.###.###.',
    '.##...##.',
    '.##...##.',
    '.##...##.',
    '.##...##.',
    '###...###'],
  glove: [
    '.#.#.#...',
    '.#.#.#...',
    '.#####.#.',
    '.#####.#.',
    '.#######.',
    '.######..',
    '..#####..',
    '..#####..',
    '..#####..'],
  boot: [
    '..####...',
    '..####...',
    '..####...',
    '..####...',
    '..####...',
    '..######.',
    '.########',
    '.########',
    '.........'],
  belt: [
    '.........',
    '.........',
    '.#####...',
    '##...####',
    '##.######',
    '##...####',
    '.#####...',
    '.........',
    '.........'],
  ring: [
    '...###...',
    '....#....',
    '..#####..',
    '.##...##.',
    '.#.....#.',
    '.#.....#.',
    '.##...##.',
    '..#####..',
    '.........'],
  snow: [
    '....#....',
    '.#..#..#.',
    '..#.#.#..',
    '...###...',
    '#########',
    '...###...',
    '..#.#.#..',
    '.#..#..#.',
    '....#....'],
  mask: [
    '.........',
    '.........',
    '#########',
    '#########',
    '##..#..##',
    '##..#..##',
    '.###.###.',
    '.........',
    '.........'],
  weight: [
    '...###...',
    '..#...#..',
    '..#...#..',
    '.#######.',
    '#########',
    '#########',
    '#########',
    '#########',
    '.#######.']
};
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rows) {
  const w = rows[0].length, h = rows.length, raw = Buffer.alloc((w * 4 + 1) * h);
  rows.forEach((r, y) => { for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; if (r[x] === '#') { raw[o] = BONE[0]; raw[o + 1] = BONE[1]; raw[o + 2] = BONE[2]; raw[o + 3] = 255; } } });
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dir = path.join(__dirname, '..', 'art', 'ui', 'kit', 'plain');
Object.keys(ICONS).forEach(n => { fs.writeFileSync(path.join(dir, 'icon_' + n + '.png'), png(ICONS[n])); console.log('icon_' + n + '.png'); });
