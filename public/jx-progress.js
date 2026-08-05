(() => {
  function isNativeApp() {
    try {
      const cap = window.Capacitor;
      if (!cap) return false;
      if (typeof cap.isNativePlatform === 'function') return !!cap.isNativePlatform();
      const p = typeof cap.getPlatform === 'function' ? cap.getPlatform() : '';
      return p === 'ios' || p === 'android';
    } catch {
      return false;
    }
  }

  window.JXProgress = {
    isNativeApp,

    async me() {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (res.status === 401) return null;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return null;
      return data.user || null;
    },

    async getAll() {
      const res = await fetch('/api/progress', { credentials: 'same-origin' });
      if (!res.ok) return { items: [], recent: null };
      return res.json();
    },

    async getOne(moduleSlug, lessonSlug) {
      const all = await this.getAll();
      return (all.items || []).find(
        (it) => it.moduleSlug === moduleSlug && it.lessonSlug === lessonSlug,
      ) || null;
    },

    async save(payload) {
      const res = await fetch('/api/progress', {
        credentials: 'same-origin',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `保存进度失败 ${res.status}`);
      return data;
    },

    /** 在学习页挂载：仅 App 端展示并同步；PC 网页不展示登录/进度相关 UI */
    async attach(opts) {
      const {
        moduleSlug,
        lessonSlug,
        getTab,
        root,
        onStatus,
      } = opts;

      if (!isNativeApp()) {
        if (root) {
          root.innerHTML = '';
          root.hidden = true;
        }
        return { user: null, skipped: true };
      }

      const user = await this.me();
      if (!user) {
        if (root) root.innerHTML = '';
        return { user: null };
      }

      let saved = null;
      try {
        saved = await this.getOne(moduleSlug, lessonSlug);
      } catch (_) {}

      let lastSent = 0;
      let completed = !!saved?.completed;

      let statusFn = typeof onStatus === 'function' ? onStatus : () => {};

      const setStatus = (text, ok = true) => {
        statusFn(text, ok);
      };

      const collectPosition = () => {
        const medias = [...document.querySelectorAll('#lesson-stage video, #lesson-stage audio')];
        let best = 0;
        for (const m of medias) {
          if (!m.paused || m.currentTime > 0) best = Math.max(best, m.currentTime || 0);
        }
        return best;
      };

      const push = async (extra = {}) => {
        const positionSec = extra.positionSec != null ? extra.positionSec : collectPosition();
        const body = {
          moduleSlug,
          lessonSlug,
          positionSec,
          completed: extra.completed != null ? extra.completed : completed,
          lastTab: (typeof getTab === 'function' ? getTab() : '') || '',
        };
        try {
          await this.save(body);
          lastSent = Date.now();
          setStatus(body.completed ? '已标记学完' : `进度已同步 ${Math.floor(positionSec)}s`);
        } catch (e) {
          setStatus(e.message || String(e), false);
        }
      };

      const maybePush = () => {
        if (Date.now() - lastSent < 8000) return;
        push();
      };

      const seekMedia = (sec) => {
        if (!sec || sec < 3) return;
        const trySeek = () => {
          document.querySelectorAll('#lesson-stage video, #lesson-stage audio').forEach((m) => {
            const apply = () => {
              try {
                if (m.duration && sec < m.duration - 1) m.currentTime = sec;
                else if (!m.duration || !Number.isFinite(m.duration)) m.currentTime = sec;
              } catch (_) {}
            };
            if (m.readyState >= 1) apply();
            else m.addEventListener('loadedmetadata', apply, { once: true });
          });
        };
        trySeek();
        setTimeout(trySeek, 600);
      };

      if (root) {
        root.innerHTML = `
          <div class="learn-progress-bar__row">
            <span class="learn-progress-bar__user">${user.username}</span>
            <button type="button" class="learn-progress-bar__btn" id="jx-mark-done">${completed ? '已学完' : '标为学完'}</button>
            <span class="learn-progress-bar__status" id="jx-progress-status"></span>
          </div>`;
        const statusEl = root.querySelector('#jx-progress-status');
        const doneBtn = root.querySelector('#jx-mark-done');
        statusFn = (text, ok = true) => {
          if (!statusEl) return;
          statusEl.textContent = text || '';
          statusEl.classList.toggle('is-error', !ok);
        };

        doneBtn?.addEventListener('click', async () => {
          completed = true;
          doneBtn.textContent = '已学完';
          await push({ completed: true });
        });
      }

      if (saved?.positionSec > 0) {
        seekMedia(saved.positionSec);
        setStatus(`已恢复至 ${Math.floor(saved.positionSec)}s`);
      } else {
        setStatus('已登录，进度将自动保存');
      }

      document.addEventListener(
        'timeupdate',
        (e) => {
          if (!(e.target instanceof HTMLMediaElement)) return;
          if (!e.target.closest('#lesson-stage')) return;
          maybePush();
        },
        true,
      );

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') push();
      });
      window.addEventListener('pagehide', () => {
        push();
      });

      // 首次写入一条，便于「继续学习」
      push({ positionSec: saved?.positionSec || 0, completed });

      return { user, saved };
    },
  };
})();
