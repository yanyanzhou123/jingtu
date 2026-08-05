/**
 * 运营后台：浏览器内处理视频
 * 默认：画面 copy + 音轨转 AAC + faststart（快，解决苹果无声）
 * 可选：深度压缩 720p（浏览器里很慢，仅小文件建议）
 */
(() => {
  let ffmpeg = null;
  let loadPromise = null;

  const CORE_CDNS = [
    'https://registry.npmmirror.com/@ffmpeg/core/0.12.10/files/dist/esm',
    'https://cdn.npmmirror.com/packages/@ffmpeg/core/0.12.10/dist/esm',
    'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm',
    'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm',
  ];

  async function blobFromCdns(path, type, toBlobURL, onStatus) {
    let lastErr;
    for (const base of CORE_CDNS) {
      try {
        const host = new URL(base).hostname;
        onStatus?.(`正在从 ${host} 下载压缩组件…`);
        return await toBlobURL(`${base}/${path}`, type);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`无法加载 ${path}（可开网络后再试，或取消勾选后直接上传）`);
  }

  async function loadFFmpeg(onStatus) {
    if (ffmpeg?.loaded) return ffmpeg;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      onStatus?.('首次使用需加载组件（约 25MB，仅一次）…');
      const { FFmpeg } = await import('/vendor/ffmpeg/index.js');
      const { toBlobURL } = await import('/vendor/ffmpeg-util/index.js');
      const ff = new FFmpeg();
      await ff.load({
        classWorkerURL: `${location.origin}/vendor/ffmpeg/worker.js`,
        coreURL: await blobFromCdns('ffmpeg-core.js', 'text/javascript', toBlobURL, onStatus),
        wasmURL: await blobFromCdns('ffmpeg-core.wasm', 'application/wasm', toBlobURL, onStatus),
      });
      ffmpeg = ff;
      onStatus?.('组件已就绪');
      return ff;
    })().catch((err) => {
      loadPromise = null;
      throw err;
    });

    return loadPromise;
  }

  async function runExec(ff, args) {
    const code = await ff.exec(args);
    if (code !== 0 && code !== true && code !== undefined) {
      // ffmpeg.wasm 成功时常返回 0；非 0 视为失败
      if (typeof code === 'number' && code !== 0) {
        throw new Error(`ffmpeg 退出码 ${code}`);
      }
    }
  }

  /**
   * @param {File} file
   * @param {{ onStatus?: (t: string) => void, onProgress?: (pct: number) => void, deep?: boolean }} [opts]
   * @returns {Promise<File>}
   */
  async function compressVideo(file, opts = {}) {
    const { onStatus, onProgress, deep = false } = opts;
    const { fetchFile } = await import('/vendor/ffmpeg-util/index.js');
    const ff = await loadFFmpeg(onStatus);

    const progressHandler = ({ progress }) => {
      const pct = Math.max(0, Math.min(99, Math.round((progress || 0) * 100)));
      onProgress?.(pct);
      onStatus?.(
        deep
          ? `正在深度压缩画面… ${pct}%（大文件可能很慢，请勿关闭）`
          : `正在转换 AAC 音轨… ${pct}%`,
      );
    };
    ff.on('progress', progressHandler);

    const inName = 'input.mp4';
    const outName = 'output.mp4';
    try {
      onStatus?.(`正在读取视频（${(file.size / 1024 / 1024).toFixed(0)}MB）…`);
      await ff.writeFile(inName, await fetchFile(file));

      let mode = 'aac';
      if (deep) {
        onStatus?.('深度压缩中：720p + H.264 + AAC（浏览器较慢）…');
        await runExec(ff, [
          '-i',
          inName,
          '-vf',
          'scale=-2:720',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '28',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-ar',
          '44100',
          '-ac',
          '2',
          '-movflags',
          '+faststart',
          '-f',
          'mp4',
          outName,
        ]);
        mode = 'deep';
      } else {
        // 快路径：不重编画面，只转 AAC（苹果微信出声的关键）
        onStatus?.('快速处理：保留画面，音轨转为 AAC…');
        try {
          await runExec(ff, [
            '-i',
            inName,
            '-c:v',
            'copy',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-ar',
            '44100',
            '-ac',
            '2',
            '-movflags',
            '+faststart',
            '-f',
            'mp4',
            outName,
          ]);
        } catch {
          // 少数容器/编码 copy 失败时，再极速重编画面
          onStatus?.('画面无法直接拷贝，改为极速重编码…');
          try {
            await ff.deleteFile(outName);
          } catch {}
          await runExec(ff, [
            '-i',
            inName,
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '26',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-ar',
            '44100',
            '-ac',
            '2',
            '-movflags',
            '+faststart',
            '-f',
            'mp4',
            outName,
          ]);
          mode = 'fallback';
        }
      }

      const data = await ff.readFile(outName);
      const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const outFile = new File(
        [bytes],
        file.name.replace(/\.[^.]+$/i, '') + '.mp4',
        { type: 'video/mp4' },
      );

      onProgress?.(100);
      const label =
        mode === 'deep' ? '深度压缩完成' : mode === 'fallback' ? '转码完成' : 'AAC 转换完成';
      onStatus?.(
        `${label}：${(file.size / 1024 / 1024).toFixed(1)}MB → ${(outFile.size / 1024 / 1024).toFixed(1)}MB`,
      );
      return outFile;
    } finally {
      ff.off('progress', progressHandler);
      try {
        await ff.deleteFile(inName);
      } catch {}
      try {
        await ff.deleteFile(outName);
      } catch {}
    }
  }

  window.JXCompressVideo = compressVideo;
})();
