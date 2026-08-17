/**
 * MP4 Faststart - 前端实现
 * 将 moov atom 移到文件开头，确保网页视频可以立即开始播放
 * 
 * MP4 文件结构：
 *   [ftyp][moov][mdat]...  (faststart 后)
 *   [ftyp][mdat]...[moov]  (faststart 前)
 */

/**
 * 解析 MP4 box 结构
 */
function parseBoxes(buffer) {
  const view = new DataView(buffer);
  const boxes = [];
  let offset = 0;
  
  while (offset < buffer.byteLength) {
    if (offset + 8 > buffer.byteLength) break;
    
    const size = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7)
    );
    
    if (size === 0) break; // 到文件末尾
    if (size === 1 && offset + 16 <= buffer.byteLength) {
      // Extended size (64-bit)
      const largeSize = view.getUint64(offset + 8);
      boxes.push({ offset, size: largeSize, type });
      offset += largeSize;
    } else {
      boxes.push({ offset, size, type });
      offset += size;
    }
  }
  
  return boxes;
}

/**
 * 检查 MP4 文件是否需要 faststart
 */
function needsFaststart(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const buffer = e.target.result;
        const boxes = parseBoxes(buffer);
        
        const ftypIdx = boxes.findIndex(b => b.type === 'ftyp');
        const moovIdx = boxes.findIndex(b => b.type === 'moov');
        const mdatIdx = boxes.findIndex(b => b.type === 'mdat');
        
        if (moovIdx === -1) {
          reject(new Error('未找到 moov atom，可能不是标准 MP4 文件'));
          return;
        }
        
        // 如果 moov 在 mdat 后面，需要 faststart
        const needs = mdatIdx !== -1 && moovIdx > mdatIdx;
        resolve({
          needs,
          boxes,
          ftypIdx,
          moovIdx,
          mdatIdx,
          fileSize: file.size,
        });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    
    // 只读前 2MB 来解析结构
    const readSize = Math.min(file.size, 2 * 1024 * 1024);
    reader.readAsArrayBuffer(file.slice(0, readSize));
  });
}

/**
 * 执行 faststart - 将 moov 移到文件开头
 */
async function mp4Faststart(file, onProgress) {
  // 1. 检查是否需要处理
  const info = await needsFaststart(file);
  
  if (!info.needs) {
    // 已经是 faststart，直接返回原文件
    return file;
  }
  
  onProgress?.(10, '正在读取视频文件结构...');
  
  // 2. 读取完整文件
  const buffer = await file.arrayBuffer();
  
  onProgress?.(30, '正在重新排列 MP4 结构...');
  
  // 3. 解析所有 box
  const boxes = parseBoxes(buffer);
  
  const ftypBox = boxes.find(b => b.type === 'ftyp');
  const moovBox = boxes.find(b => b.type === 'moov');
  
  if (!ftypBox || !moovBox) {
    throw new Error('MP4 文件结构异常');
  }
  
  // 4. 提取各部分数据
  const ftypData = new Uint8Array(buffer, ftypBox.offset, ftypBox.size);
  const moovData = new Uint8Array(buffer, moovBox.offset, moovBox.size);
  
  // 5. 提取除 ftyp 和 moov 外的所有数据
  const otherChunks = [];
  let totalOtherSize = 0;
  
  for (const box of boxes) {
    if (box.type !== 'ftyp' && box.type !== 'moov') {
      const chunk = new Uint8Array(buffer, box.offset, box.size);
      otherChunks.push(chunk);
      totalOtherSize += box.size;
    }
  }
  
  onProgress?.(60, '正在重组文件...');
  
  // 6. 创建新文件：[ftyp][moov][others...]
  const totalSize = ftypBox.size + moovBox.size + totalOtherSize;
  const newBuffer = new ArrayBuffer(totalSize);
  const newView = new Uint8Array(newBuffer);
  
  // 写入 ftyp
  newView.set(ftypData, 0);
  
  // 写入 moov
  newView.set(moovData, ftypBox.size);
  
  // 写入其他部分
  let writeOffset = ftypBox.size + moovBox.size;
  for (const chunk of otherChunks) {
    newView.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  
  onProgress?.(90, '正在生成新文件...');
  
  // 7. 返回新 Blob
  const result = new Blob([newBuffer], { type: 'video/mp4' });
  const resultFile = new File([result], file.name, { type: 'video/mp4' });
  
  onProgress?.(100, '完成！');
  
  return resultFile;
}

/**
 * 便捷方法：在上传前自动处理 faststart
 */
async function autoFaststartBeforeUpload(file, options = {}) {
  const { onProgress, force = false } = options;
  
  // 只处理 MP4 文件
  if (!file.name.toLowerCase().endsWith('.mp4') && file.type !== 'video/mp4') {
    return file;
  }
  
  try {
    const info = await needsFaststart(file);
    
    if (!info.needs && !force) {
      onProgress?.(100, '视频已是 faststart 格式，无需处理');
      return file;
    }
    
    onProgress?.(5, '检测到视频 moov 在文件末尾，正在优化...');
    return await mp4Faststart(file, onProgress);
  } catch (err) {
    console.warn('Faststart 处理失败，将使用原文件:', err.message);
    return file;
  }
}

// 兼容 CommonJS 和浏览器全局
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mp4Faststart, needsFaststart, autoFaststartBeforeUpload };
} else {
  // 浏览器环境：暴露到全局
  window.mp4Faststart = mp4Faststart;
  window.needsFaststart = needsFaststart;
  window.autoFaststartBeforeUpload = autoFaststartBeforeUpload;
}