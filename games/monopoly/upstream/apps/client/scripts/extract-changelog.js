import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 1. 在 ESM 中手动构建 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 2. 调整路径解析
const changelogPath = path.resolve(__dirname, '../CHANGELOG.md');
const outputPath = path.resolve(__dirname, '../build/release-notes.md');

console.log('📝 正在提取更新日志...');
console.log('   源文件:', changelogPath);
console.log('   输出到:', outputPath);

try {
  // 检查源文件是否存在
  if (!fs.existsSync(changelogPath)) {
    console.warn('⚠️ 未找到 CHANGELOG.md，生成默认空日志。');
    writeEmptyNotes();
    process.exit(0);
  }

  const content = fs.readFileSync(changelogPath, 'utf-8');

  // 兼容 Changeset 默认生成的 Markdown 格式
  const match = content.match(/## \d+\.\d+\.\d+.*?\n([\s\S]*?)(?=## \d+\.\d+\.\d+|$)/);

  if (match && match[1]) {
    let rawNotes = match[1];

    //清洗文本
    const notes = rawNotes
      .split('\n') // 1. 按行分割
      .filter(line => {
        const text = line.trim();
        // 2. 移除空行
        if (!text) return false;
        // 3. 移除 Changeset 的分类标题
        if (text.startsWith('### ')) return false;
        return true;
      })
      .join('\n'); // 4. 重新组合

    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    // 写入文件
    fs.writeFileSync(outputPath, notes);

    console.log('✅ release-notes.md 生成成功！');
  } else {
    console.warn('⚠️ CHANGELOG 格式未匹配到最新版本内容，使用默认值。');
    writeEmptyNotes();
  }
} catch (e) {
  console.error('❌ 提取日志脚本执行出错:', e);
  writeEmptyNotes();
}

function writeEmptyNotes() {
  try {
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({ notes: '暂无详细更新日志' }));
  } catch (e) { }
}