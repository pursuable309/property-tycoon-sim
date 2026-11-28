/**
 * UI: Sim Lab tab (GitHub Actions A/B runs)
 *
 * The fourth setup-screen tab (beside New Game / History / Stats) and the
 * home of every developer tool. Monitors the CPU-AI A/B jobs that
 * `ai-lab/gh_ab.sh` runs on GitHub Actions and annotates them; it never
 * submits (that stays in the CLI, behind the dry-run scan). Everything comes from server.py's /api/lab/* (lab_api.py), which
 * shells out to gh_ab.sh, so states here always match `gh_ab.sh list`.
 *
 *   - Active   : watching / unwatched jobs — progress + ETA (public Actions
 *                API, server-cached 90s), purpose, effort link
 *   - Completed: success / failure / timeout — headline top-difficulty win
 *                delta per arm, filterable
 *   - Detail modal: job spec, purpose/effort editor (gh_ab.sh note), parsed
 *                results table, raw report.txt; effort chip opens the
 *                docs/ai/efforts record
 *   - Proposals view: the lever pipeline (docs/ai/PIPELINE.md) — proposals
 *                to approve / reject, GO levers to ship / hold, and what the
 *                pipeline is working on. Decisions need the API token
 *                (api_auth.py): kept in localStorage, got by a one-time code
 *                sent as a Termux notification or by pasting it.
 *   - Reviews view: the Claude review queue, tuning suggested across reviewed
 *                games (HistoryUI._aggregatePanel) and the review analysis
 *                (StatsUI.renderClaudeInto: word cloud, findings leaderboard).
 *   - Tuning view: the AI knob editor (TuningUI.render), for new games.
 *   - Human-only view: every rule that treats a human trade partner
 *                differently (AITuning.HUMAN_RULES), with its live setting.
 *                Sims have no humans, so A/B runs cannot see these.
 *
 * Polling runs only while the tab is shown: setup.js calls render() on
 * activation and stop() on leaving.
 *
 * Exports: window.LabUI
 */
const LabUI = {

    LIST_POLL_MS: 30000,
    ETA_POLL_MS: 90000,
    STATE_LABEL: { watching: 'running', unwatched: 'no watcher', success: 'ok', failure: 'failed', timeout: 'timed out' },
    // Metrics where a positive arm-vs-base delta is the good direction.
    UP_GOOD: ['win', 'capWin', 'dev%', 'mono/srv', 'setComplete/game'],

    _filter: 'all',
    _view: 'runs',       // 'runs' | 'proposals' | 'reviews' | 'tuning' | 'human'
    // Subtabs: [view, one-word label, icon]
    VIEWS: [['runs', 'Runs', 'activity'], ['proposals', 'Levers', 'lightbulb'], ['reviews', 'Reviews', 'bot'],
        ['tuning', 'Tuning', 'settings'], ['human', 'Rules', 'user']],
    JOBS_CACHE_KEY: 'pt_lab_jobs',   // sessionStorage: last job list, painted while the next loads
    _jobs: null,
    _eta: {},            // job id -> { at, data }
    _timer: null,

    /* ==================== Lifecycle ==================== */

    async render() {
        const root = document.getElementById('lab-root');
        if (!root) return;
        this.stop();
        root.innerHTML = '';
        this._content = null;
        root.appendChild(this._toolbar());
        this._content = root.appendChild(this._el('div', 'lab-content'));
        if (!this._jobs) {
            try { this._jobs = JSON.parse(sessionStorage.getItem(this.JOBS_CACHE_KEY) || 'null'); } catch (e) { this._jobs = null; }
        }
        if (this._view !== 'runs') this._paint();
        else if (this._jobs) { this._paint(); this._content.prepend(this._el('div', 'lab-refreshing', 'Refreshing…')); }
        else this._content.appendChild(this._el('div', 'history-empty', 'Loading runs…'));
        await this._refresh();
        this._timer = setInterval(() => {
            if (!document.hidden) this._refresh();
        }, this.LIST_POLL_MS);
    },

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    },

    async _refresh() {
        let jobs;
        try {
            const r = await fetch('/api/lab/jobs');
            if (!r.ok) throw new Error(String(r.status));
            jobs = await r.json();
        } catch (e) {
            this._jobs = null;
            this._runsBadge();
            this._paintOffline();
            return;
        }
        // A run that just landed while the tab is open: say so.
        if (this._jobs) {
            const before = new Map(this._jobs.map(j => [j.id, j.state]));
            jobs.forEach(j => {
                if (before.get(j.id) === 'watching' && !this._isActive(j)) {
                    showNotification(`Sim A/B ${this._short(j.id)}: ${j.state}`, j.state === 'success' ? 'success' : 'error');
                }
            });
        }
        this._jobs = jobs.slice().reverse();   // newest first
        this._runsBadge();
        try { sessionStorage.setItem(this.JOBS_CACHE_KEY, JSON.stringify(this._jobs)); } catch (e) { /* full: no cache */ }
        // The 30s poll repaints only the live views (never under an open
        // Tuning editor or a Reviews drill-down)
        if (this._view === 'runs' || this._view === 'proposals') this._paint();
        this._jobs.filter(j => this._isActive(j)).forEach(j => this._maybeEta(j));
    },

    async _maybeEta(job, force) {
        const hit = this._eta[job.id];
        if (!force && hit && Date.now() - hit.at < this.ETA_POLL_MS) return;
        this._eta[job.id] = { at: Date.now(), data: hit ? hit.data : null };
        try {
            const r = await fetch(`/api/lab/jobs/${encodeURIComponent(job.id)}/eta`);
            this._eta[job.id].data = await r.json();
        } catch (e) {
            this._eta[job.id].data = { ok: false, text: 'ETA unavailable (server unreachable)' };
        }
        const card = this._content && this._content.querySelector(`[data-job="${CSS.escape(job.id)}"] .lab-progress`);
        if (card) card.replaceWith(this._progress(job));
    },

    /* ==================== List ==================== */

    _toolbar() {
        const wrap = this._el('div', 'lab-head');
        const views = this._el('div', 'lab-views');
        views.innerHTML = Icons.subtabs('Lab sections', this.VIEWS);
        this._labBar = views;   // badge target (_setBadge); the bar is not in the page yet
        wrap.appendChild(views);
        const bar = wrap.appendChild(this._el('div', 'lab-toolbar'));
        const title = bar.appendChild(this._el('div', 'lab-toolbar-title', this.VIEW_TITLE[this._view]));
        const refresh = bar.appendChild(this._btn('↻ Refresh', 'btn-secondary btn-sm', () => {
            this._eta = {};
            this._view === 'runs' ? this._refresh() : this._paint();
        }));
        // Shared subtabs (remembers the last view); onShow also runs once at init,
        // before render() has its content box, which only sets the chrome
        Subtabs.init('lab', { root: views, storageKey: 'pt-lab-view', aliases: { rules: 'human' }, onShow: v => {
            this._view = v;
            refresh.hidden = !this._refreshable();
            title.textContent = this.VIEW_TITLE[v];
            if (!this._content) return;
            v === 'runs' && !this._jobs ? this._refresh() : this._paint();
        } });
        // The bar is new on every render: put the last known badges back on it
        this._repaintBadges();
        if (this._jobs) this._runsBadge();
        return wrap;
    },

    _refreshable() { return this._view === 'runs' || this._view === 'proposals' || this._view === 'reviews'; },

    _paintOffline() {
        if (!this._content || this._view !== 'runs') return;
        this._content.innerHTML = '';
        const box = this._el('div', 'history-empty');
        box.innerHTML = 'Sim Lab needs the local server (<code>python3 server.py</code>) — it reads ' +
            '<code>ai-lab/runs/gh/</code> through <code>gh_ab.sh</code>.';
        this._content.appendChild(box);
    },

    _paint() {
        if (this._view === 'human') return this._paintHumanRules();
        if (this._view === 'reviews') return this._paintReviews();
        if (this._view === 'tuning') return this._paintTuning();
        if (this._view === 'proposals') return this._paintProposals();
        if (!this._content || !this._jobs) return;
        this._content.innerHTML = '';
        if (!this._jobs.length) {
            this._content.innerHTML = '<div class="history-empty">No runs yet. Submit one with ' +
                '<code>gh_ab.sh submit</code>.</div>';
            return;
        }
        const active = this._jobs.filter(j => this._isActive(j));
        const done = this._jobs.filter(j => !this._isActive(j));

        this._content.appendChild(this._el('div', 'history-section-title', `Active (${active.length})`));
        if (!active.length) this._content.appendChild(this._el('div', 'lab-none', 'No run in flight.'));
        active.forEach(j => this._content.appendChild(this._activeCard(j)));

        const head = this._el('div', 'lab-done-head');
        head.appendChild(this._el('div', 'history-section-title', `Completed (${done.length})`));
        const seg = this._el('div', 'lab-filter');
        seg.innerHTML = Segmented.html('lab-filter', [
            ['all', 'All'], ['success', 'OK'], ['failed', 'Failed']
        ], this._filter, 'Filter completed runs');
        seg.addEventListener('change', () => {
            this._filter = Segmented.value(seg, 'lab-filter') || 'all';
            this._paint();
        });
        head.appendChild(seg);
        this._content.appendChild(head);

        const shown = done.filter(j => this._filter === 'all' ||
            (this._filter === 'success') === (this._outcome(j) === 'success'));
        if (!shown.length) this._content.appendChild(this._el('div', 'lab-none', 'Nothing matches.'));
        const list = this._content.appendChild(this._el('div', 'lab-list'));
        shown.forEach(j => list.appendChild(this._doneRow(j)));
    },

    _activeCard(job) {
        const card = this._el('div', 'history-card lab-card lab-card-active');
        card.dataset.job = job.id;
        card.appendChild(this._cardHead(job));
        card.appendChild(this._el('div', 'lab-spec', this._spec(job.job)));
        card.appendChild(this._progress(job));
        if (job.state === 'unwatched') {
            const warn = this._el('div', 'lab-warn');
            warn.innerHTML = `No live watcher — run <code>gh_ab.sh wait ${this._esc(job.id)}</code>`;
            card.appendChild(warn);
        }
        card.appendChild(this._purposeLine(job));
        card.addEventListener('click', e => { if (!e.target.closest('.lab-effort')) this.openJob(job.id); });
        return card;
    },

    _doneRow(job) {
        const row = this._el('div', 'history-card lab-card lab-row');
        row.dataset.job = job.id;
        row.appendChild(this._cardHead(job));
        const spec = this._el('div', 'lab-spec', this._spec(job.job) +
            (job.cells ? `  ·  ${job.cells.done}/${job.cells.total} cells` : ''));
        row.appendChild(spec);
        const deltas = this._el('div', 'lab-deltas');
        const hl = job.headline || [];
        if (!job.hasReport) deltas.appendChild(this._el('span', 'lab-muted', 'no report'));
        else if (!hl.length) deltas.appendChild(this._el('span', 'lab-muted', 'baseline only'));
        hl.forEach(h => {
            const chip = this._el('span', 'score-chip lab-delta');
            chip.innerHTML = `${this._esc(h.shape)} ${this._esc(h.arm)} d${h.top} ` +
                `<strong class="${this._tone('win', h.win)}">${this._sgn(h.win)}</strong>` +
                (h.violations ? ` <span class="lab-neg">⚠${h.violations}</span>` : '');
            deltas.appendChild(chip);
        });
        row.appendChild(deltas);
        row.appendChild(this._purposeLine(job));
        row.addEventListener('click', e => { if (!e.target.closest('.lab-effort')) this.openJob(job.id); });
        return row;
    },

    _cardHead(job) {
        const head = this._el('div', 'history-card-head');
        const title = this._el('span', 'lab-title');
        title.appendChild(this._badge(job));
        title.appendChild(document.createTextNode(' ' + this._short(job.id)));
        title.title = job.id;
        head.appendChild(title);
        const when = this._el('span', 'lab-when', this._ago(this._submitted(job)));
        const j = job.job || {};
        if (j.head) when.textContent += `  ·  ${j.head}${j.dirty ? '+dirty' : ''}`;
        head.appendChild(when);
        return head;
    },

    _progress(job) {
        const wrap = this._el('div', 'lab-progress');
        const e = this._eta[job.id] && this._eta[job.id].data;
        const total = (e && e.progress && e.progress.total) || this._cellCount(job.job);
        const doneN = e && e.progress ? e.progress.done : 0;
        const runN = e && e.progress ? e.progress.running : 0;
        const bar = wrap.appendChild(this._el('div', 'lab-bar'));
        const fill = bar.appendChild(this._el('div', 'lab-bar-done'));
        fill.style.width = total ? `${(100 * doneN / total).toFixed(1)}%` : '0%';
        const run = bar.appendChild(this._el('div', 'lab-bar-run'));
        run.style.width = total ? `${(100 * runN / total).toFixed(1)}%` : '0%';
        let text;
        if (!e) text = `${total} cells — checking Actions…`;
        else if (!e.progress) text = e.text || 'ETA unavailable';
        else {
            const p = e.progress;
            text = `${p.done}/${p.total} done · ${p.running} running · ${p.queued} queued` +
                (p.failed ? ` · ${p.failed} failed` : '') +
                (e.etaMin != null
                    ? `  —  ETA ~${e.etaMin} min (${e.etaLocal}` +
                      (e.etaRange ? `, likely ${e.etaRange[0]}–${e.etaRange[1]}` : '') + ')'
                    : (e.etaNote ? `  —  ETA ${e.etaNote}` : ''));
        }
        wrap.appendChild(this._el('div', 'lab-progress-text', text));
        // When the Actions API was last asked (server-side, so the 90s cache
        // shows its true age); re-rendered with every 30s list refresh.
        if (e && e.fetchedAt) {
            const ago = Date.now() / 1000 - e.fetchedAt < 60 ? 'just now' : this._ago(e.fetchedAt);
            const upd = this._el('div', 'lab-updated', `Last updated ${this._fmtTime(e.fetchedAt, true)} · ${ago}`);
            upd.title = 'Progress/ETA from the GitHub Actions API (refreshed every 90s while this tab is open)';
            wrap.appendChild(upd);
        }
        return wrap;
    },

    _purposeLine(job) {
        const line = this._el('div', 'lab-purpose');
        const purpose = (job.meta && job.meta.purpose) || '';
        line.appendChild(this._el('span', purpose ? '' : 'lab-muted', purpose || 'No purpose noted'));
        (job.efforts || []).forEach(ef => line.appendChild(this._effortChip(ef)));
        return line;
    },

    _effortChip(ef) {
        const chip = this._el('button', 'score-chip lab-effort', ef.id);
        chip.type = 'button';
        chip.title = ef.title || ef.id;
        chip.addEventListener('click', e => { e.stopPropagation(); this.openEffort(ef.id); });
        return chip;
    },

    /* ==================== Tab badge ==================== */

    BADGE_POLL_MS: 60000,
    _badgeTimer: null,

    /** Badges on the Lab setup tab. Pipeline badge: amber = levers waiting for the
     *  user (approve / ship), green = levers the pipeline is working on. Review badge
     *  (ink): finished games queued for Claude review. Polls while the setup screen
     *  is shown. */
    startBadge() {
        this.refreshBadge();   // also on every return to the setup screen (a game just queued)
        if (this._badgeTimer) return;
        this._badgeTimer = setInterval(() => {
            const tab = document.querySelector('.home-subtabs > button[data-view="lab"]');
            if (!document.hidden && tab && tab.offsetParent !== null) this.refreshBadge();
        }, this.BADGE_POLL_MS);
    },

    /** Refresh both badges. `data` = a /api/lab/proposals answer already in hand,
     *  `summaries` = a GameHistory.list() already in hand (either skips its fetch). */
    async refreshBadge(data, summaries) {
        await Promise.all([this._pipelineBadge(data), this.refreshReviewBadge(summaries)]);
    },

    async _pipelineBadge(data) {
        if (!data) {
            try {
                const r = await fetch('/api/lab/proposals');
                if (!r.ok) throw new Error(String(r.status));
                data = await r.json();
            } catch (e) {
                data = null;   // offline / static server: no badge
            }
        }
        const waiting = data ? (data.waiting || []).length : 0;
        const running = data ? (data.running || []).length : 0;
        const label = waiting
            ? `${waiting} lever${waiting === 1 ? '' : 's'} waiting for you` +
              (running ? `, ${running} in the pipeline` : '')
            : `${running} lever${running === 1 ? '' : 's'} in the pipeline`;
        this._setBadge('pipeline', waiting || running, waiting ? 'tab-badge-waiting' : 'tab-badge-running', label);
    },

    /** Games queued for Claude review (finished, not yet Claude-reviewed). */
    _queuedReviews(summaries) {
        return summaries.filter(s => s.reviewRequested && !(s.review && s.review.engine === 'claude')).length;
    },

    async refreshReviewBadge(summaries) {
        if (!summaries) {
            try { summaries = await GameHistory.list(); } catch (e) { summaries = []; }
        }
        const queued = this._queuedReviews(summaries);
        this._setBadge('reviews', queued, 'tab-badge-reviews',
            `${queued} game${queued === 1 ? '' : 's'} queued for Claude review`);
    },

    // Which Lab subtab carries each badge (runs: only inside the Lab, not on the home tab)
    BADGE_VIEW: { pipeline: 'proposals', reviews: 'reviews', runs: 'runs' },
    _badges: {},         // kind -> [count, cls, label]: repainted when the Lab bar is rebuilt

    /** Show / update / remove one badge: on the home Lab tab (pipeline, reviews) and on its
     *  own Lab subtab (Levers, Reviews, Runs) while the Lab is open. */
    _setBadge(kind, count, cls, label) {
        this._badges[kind] = [count, cls, label];
        if (kind !== 'runs') this._paintBadge(document.querySelector('.home-subtabs > button[data-view="lab"]'), kind, count, cls, label);
        if (this._labBar) this._paintBadge(this._labBar.querySelector(`.ui-subtabs > button[data-view="${this.BADGE_VIEW[kind]}"]`), kind, count, cls, label);
    },

    _repaintBadges() {
        Object.entries(this._badges).forEach(([kind, b]) => this._setBadge(kind, ...b));
    },

    /** Active A/B runs (watching, or unwatched and not finished) on the Runs subtab. */
    _runsBadge() {
        const n = this._jobs ? this._jobs.filter(j => this._isActive(j)).length : 0;
        this._setBadge('runs', n, 'tab-badge-running', `${n} A/B run${n === 1 ? '' : 's'} in progress`);
    },

    /** One badge on one tab button; the pipeline badge stays first. */
    _paintBadge(tab, kind, count, cls, label) {
        if (!tab) return;
        // Badges ride in one corner box (a subtab's count spot)
        let box = tab.querySelector('.tab-badges');
        let badge = box && box.querySelector(`.tab-badge[data-badge="${kind}"]`);
        if (!count) {
            if (badge) badge.remove();
            if (box && !box.children.length) box.remove();
            return;
        }
        if (!box) box = tab.appendChild(this._el('span', 'tab-badges'));
        if (!badge) {
            badge = this._el('span', 'tab-badge');
            badge.dataset.badge = kind;
            const reviews = box.querySelector('.tab-badge[data-badge="reviews"]');
            if (kind === 'pipeline' && reviews) box.insertBefore(badge, reviews);
            else box.appendChild(badge);
        }
        badge.className = `tab-badge ${cls}`;
        badge.textContent = String(count);
        badge.title = label;
        badge.setAttribute('aria-label', label);
    },

    /* ==================== Lever pipeline (proposals) ==================== */

    VIEW_TITLE: {
        runs: 'GitHub Actions A/B runs', proposals: 'Levers waiting for you',
        reviews: 'Claude reviews of your games', tuning: 'AI knobs for new games',
        human: 'Rules that only apply to you'
    },
    TOKEN_KEY: 'monopoly_api_token',
    STAGE_LABEL: {
        build: 'building', smoke: 'smoke run', full: 'full A/B', narrow: 'narrowing', replicate: 'fresh-seed repeat',
        decide: 'deciding', 'ship-pending': 'waiting for you', 'ship-approved': 'shipping', 'ship-declined': 'kept off', done: 'done'
    },

    async _paintProposals() {
        if (!this._content) return;
        let data;
        try {
            const r = await fetch('/api/lab/proposals');
            data = await r.json();
            if (!r.ok) throw new Error(data.error || r.status);
        } catch (e) {
            if (this._view === 'proposals') {
                this._content.innerHTML = '';
                this._content.appendChild(this._el('div', 'history-empty', `Could not load proposals (${e.message}).`));
            }
            return;
        }
        this._pipelineBadge(data);
        if (this._view !== 'proposals') return;   // switched away while loading
        this._content.innerHTML = '';
        this._content.appendChild(this._el('div', 'lab-intro',
            'Levers the AI pipeline suggests. Approve one and it is built and A/B-tested by fixed rules ' +
            '(docs/ai/PIPELINE.md) until a go or no-go; a go comes back here for you to ship or keep off.'));
        const section = (label, items, make, empty) => {
            this._content.appendChild(this._el('div', 'history-section-title', `${label} (${items.length})`));
            if (!items.length) { if (empty) this._content.appendChild(this._el('div', 'lab-none', empty)); return; }
            const list = this._content.appendChild(this._el('div', 'lab-list'));
            items.forEach(p => list.appendChild(make(p)));
        };
        section('Waiting for you', data.waiting || [], p => this._proposalCard(p), 'Nothing to decide.');
        section('In the pipeline', data.running || [], p => this._proposalCard(p), 'No lever in the pipeline.');
        if ((data.declined || []).length) section('Declined', data.declined, p => this._proposalCard(p));
    },

    _proposalCard(p) {
        const card = this._el('div', 'history-card lab-card lab-proposal');
        const head = card.appendChild(this._el('div', 'history-card-head'));
        head.appendChild(this._el('span', 'lab-title', `${p.id} — ${p.title || ''}`));
        const badge = p.ask === 'proposal' ? 'proposal' : p.ask === 'ship' ? 'ready to ship'
            : p.status === 'DECLINED' ? 'declined' : (this.STAGE_LABEL[p.pipeline_stage] || p.pipeline_stage || '');
        head.appendChild(this._el('span', `lab-badge${p.ask ? ' lab-badge-watching' : ''}`, badge));
        if (p.headline) card.appendChild(this._el('div', 'lab-rule-text', p.headline));
        const meta = card.appendChild(this._el('div', 'lab-purpose'));
        if (p.exposure) meta.appendChild(this._el('span', 'lab-muted', `Exposure: ${p.exposure}`));
        if (p.pipeline_budget) meta.appendChild(this._el('span', 'score-chip lab-knob',
            `${p.pipeline_cells || 0}/${p.pipeline_budget} cells`));
        meta.appendChild(this._effortChip({ id: p.id, title: p.title }));
        if (p.ask) {
            const acts = card.appendChild(this._el('div', 'lab-actions'));
            const [yes, no, yesLabel, noLabel] = p.ask === 'proposal'
                ? ['approve', 'reject', 'Approve', 'Reject'] : ['ship', 'hold', 'Ship', "Don't ship"];
            acts.appendChild(this._btn(noLabel, 'btn-secondary btn-sm', e => { e.stopPropagation(); this._confirmNo(p, no, noLabel); }));
            acts.appendChild(this._btn(yesLabel, 'btn-primary btn-sm', e => { e.stopPropagation(); this._decide(p.id, yes); }));
        }
        card.addEventListener('click', e => { if (!e.target.closest('.lab-effort, .lab-actions')) this.openEffort(p.id); });
        return card;
    },

    /** Reject / Don't ship: ask for an optional reason (kept in the effort file). */
    _confirmNo(p, decision, label) {
        const body = this._el('div', 'lab-signin');
        body.appendChild(this._el('p', 'lab-intro', decision === 'reject'
            ? `${p.id} will not be built or proposed again. A reason helps the next proposals.`
            : `${p.id} stays in the code, switched off.`));
        const input = body.appendChild(this._el('input', 'lab-input'));
        input.type = 'text';
        input.maxLength = 500;
        input.placeholder = 'Reason (optional)';
        Modals.show({
            title: `${label}: ${p.id}`,
            body,
            buttons: [
                { label: 'Cancel', class: 'btn-secondary' },
                { label, class: 'btn-danger', onClick: () => this._decide(p.id, decision, input.value) }
            ]
        });
    },

    async _decide(id, decision, reason, retried) {
        const token = localStorage.getItem(this.TOKEN_KEY) || await this._signIn();
        if (!token) return;
        let r, res = {};
        try {
            r = await fetch(`/api/lab/proposals/${encodeURIComponent(id)}/decision`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ decision, reason: reason || '' })
            });
            res = await r.json().catch(() => ({}));
        } catch (e) {
            showNotification('Server unreachable — decision not saved', 'error');
            return;
        }
        if (r.status === 401 && !retried) {
            localStorage.removeItem(this.TOKEN_KEY);   // stale or wrong token: sign in again
            return this._decide(id, decision, reason, true);
        }
        if (!r.ok) {
            showNotification(`${id}: ${res.error || `failed (${r.status})`}`, 'error');
            return;
        }
        const done = { approve: 'approved: the pipeline picks it up next', reject: 'declined',
                       ship: 'ship approved', hold: 'kept off' }[decision];
        showNotification(`${id} ${done}`, 'success');
        this._paint();
    },

    /** Get the API token: a one-time code sent as a Termux notification, or a pasted
     *  token checked at /api/lab/auth. Resolves to the token, or null if cancelled. */
    _signIn() {
        return new Promise(resolve => {
            let settled = false;
            const finish = (token) => {
                if (settled) return;
                settled = true;
                if (token) { localStorage.setItem(this.TOKEN_KEY, token); Modals.close(); }
                resolve(token || null);
            };
            const body = this._el('div', 'lab-signin');
            body.appendChild(this._el('p', 'lab-intro',
                'Decisions need the app token. Send a one-time code to your notifications and type it here, ' +
                'or paste the token (Mission Control\'s api_token).'));
            const code = body.appendChild(this._el('input', 'lab-input'));
            Object.assign(code, { type: 'text', inputMode: 'numeric', maxLength: 6, placeholder: '6-digit code',
                                  autocomplete: 'one-time-code' });
            const pasted = body.appendChild(this._el('input', 'lab-input'));
            Object.assign(pasted, { type: 'password', placeholder: 'or paste the token', autocomplete: 'off' });
            const status = body.appendChild(this._el('div', 'lab-muted', ''));
            const post = async (url, data) => {
                const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                             body: JSON.stringify(data || {}) });
                return [r, await r.json().catch(() => ({}))];
            };
            Modals.show({
                title: 'Sign in to decide',
                body,
                buttons: [
                    { label: 'Cancel', class: 'btn-secondary', onClick: () => finish(null) },
                    { label: '📤 Send code', class: 'btn-secondary', keepOpen: true, onClick: async () => {
                        try {
                            const [r, res] = await post('/api/lab/signin/notify');
                            status.textContent = r.ok ? 'Code sent — check your notifications.' : (res.error || `Failed (${r.status})`);
                        } catch (e) { status.textContent = 'Server unreachable.'; }
                    } },
                    { label: '🔑 Sign in', class: 'btn-primary', keepOpen: true, onClick: async () => {
                        try {
                            if (code.value.trim()) {
                                const [r, res] = await post('/api/lab/signin/code', { code: code.value.trim() });
                                if (r.ok && res.token) return finish(res.token);
                                status.textContent = res.error || `Failed (${r.status})`;
                            } else if (pasted.value.trim()) {
                                const t = pasted.value.trim();
                                const r = await fetch('/api/lab/auth', { headers: { Authorization: `Bearer ${t}` } });
                                const res = await r.json().catch(() => ({}));
                                if (res.signedIn) return finish(t);
                                status.textContent = 'That token is not right.';
                            } else {
                                status.textContent = 'Send a code first, or paste the token.';
                            }
                        } catch (e) { status.textContent = 'Server unreachable.'; }
                    } }
                ]
            });
        });
    },

    /* ==================== Reviews + Tuning ==================== */

    /** Review queue, tuning suggested across reviewed games, and the review
     *  analysis (word cloud + findings), all read from the game archive. */
    async _paintReviews() {
        if (!this._content) return;
        const content = this._content;
        content.innerHTML = '';
        let summaries = [];
        try { summaries = await GameHistory.list(); } catch (e) { /* offline: empty */ }
        if (this._view !== 'reviews' || this._content !== content) return;   // switched away

        const queued = this._queuedReviews(summaries);
        this.refreshReviewBadge(summaries);
        const queue = content.appendChild(this._el('div', 'history-card lab-queue'));
        queue.appendChild(this._el('div', 'lab-queue-num', String(queued)));
        queue.appendChild(this._el('div', 'lab-queue-text', queued
            ? `game${queued === 1 ? '' : 's'} queued for Claude review: run the review-games skill to process ${queued === 1 ? 'it' : 'them'}.`
            : 'games waiting: every finished game has been reviewed.'));

        HistoryUI._readOnly = false;   // Apply buttons on (they're hidden mid-game)
        const recs = HistoryUI._aggregatePanel(summaries);
        if (recs) content.appendChild(recs);

        const analysis = content.appendChild(this._el('div', 'lab-review-analysis'));
        if (window.StatsUI) StatsUI.renderClaudeInto(analysis);
    },

    _paintTuning() {
        if (!this._content) return;
        this._content.innerHTML = '';
        if (window.TuningUI) TuningUI.render(this._content);
    },

    /* ==================== Human-only rules ==================== */

    HUMAN_SCOPE_LABEL: { human: 'human only', 'human+': 'human + d5 vs CPUs', all: 'all partners', off: 'off' },

    _paintHumanRules() {
        if (!this._content) return;
        this._content.innerHTML = '';
        if (!window.AITuning || !AITuning.humanRules) {
            this._content.appendChild(this._el('div', 'history-empty', 'AI tuning is not loaded.'));
            return;
        }
        const rules = AITuning.humanRules();
        const intro = this._el('div', 'lab-intro');
        intro.innerHTML = 'How CPUs treat <strong>you</strong> differently from another CPU in trades. ' +
            'Sims have no humans, so A/B runs cannot measure these. The levers were shipped human-only on ' +
            'decision replays of recorded games, after their all-partner form lost or tied in CPU-only A/Bs; ' +
            'the last two are fixed assumptions about you. Values reflect your AI tuning (Tuning view).';
        this._content.appendChild(intro);
        const live = rules.filter(r => r.scope === 'human' || r.scope === 'human+').length;
        this._content.appendChild(this._el('div', 'history-section-title',
            `Active for humans (${live} of ${rules.length})`));
        const list = this._content.appendChild(this._el('div', 'lab-list'));
        rules.forEach(r => list.appendChild(this._ruleCard(r)));
    },

    _ruleCard(r) {
        const card = this._el('div', 'history-card lab-card lab-rule');
        const head = card.appendChild(this._el('div', 'history-card-head'));
        head.appendChild(this._el('span', 'lab-title', r.title));
        const scope = r.scope === 'human+' ? 'human' : r.scope;
        head.appendChild(this._el('span', `lab-badge lab-scope-${scope}`, this.HUMAN_SCOPE_LABEL[r.scope] || r.scope));
        card.appendChild(this._el('div', 'lab-rule-text', r.text));
        const meta = card.appendChild(this._el('div', 'lab-purpose'));
        meta.appendChild(this._el('span', 'lab-muted', r.who));
        r.knobs.forEach(k => {
            const chip = this._el('span', 'score-chip lab-knob', `${k.label}: ${k.value}`);
            chip.title = `${k.path}${k.overridden ? ` (default ${k.def})` : ' (default)'}`;
            if (k.overridden) chip.classList.add('lab-knob-set');
            meta.appendChild(chip);
        });
        if (!r.knobs.length) meta.appendChild(this._el('span', 'lab-muted', 'fixed (no knob)'));
        if (r.effort) meta.appendChild(this._effortChip({ id: r.effort, title: r.effort }));
        return card;
    },

    /* ==================== Detail modal ==================== */

    async openJob(id) {
        let job;
        try {
            const r = await fetch(`/api/lab/jobs/${encodeURIComponent(id)}`);
            job = await r.json();
            if (!r.ok) throw new Error(job.error || r.status);
        } catch (e) {
            showNotification(`Could not load ${this._short(id)}: ${e.message}`, 'error');
            return;
        }
        const body = this._el('div', 'history-detail lab-detail');
        body.appendChild(this._specBlock(job));
        body.appendChild(this._metaEditor(job));
        if (this._isActive(job)) {
            body.appendChild(this._el('div', 'history-section-title', 'Progress'));
            body.appendChild(this._progress(job));
        }
        body.appendChild(this._resultsBlock(job));
        if (job.report) {
            const det = this._el('details', 'lab-raw');
            det.appendChild(this._el('summary', '', 'Raw report.txt'));
            det.appendChild(this._el('pre', 'lab-pre', job.report));
            body.appendChild(det);
        }
        Modals.show({
            title: `${this._short(job.id)} — ${this.STATE_LABEL[this._outcome(job)] || job.state}`,
            body,
            buttons: [{ label: 'Close', class: 'btn-secondary' }]
        });
    },

    _specBlock(job) {
        const wrap = this._el('div', 'lab-spec-block');
        wrap.appendChild(this._el('div', 'history-section-title', 'Job'));
        const j = job.job || {};
        const rows = [
            ['id', job.id],
            ['state', job.state + (job.result && job.result !== job.state ? ` (cells: ${job.result})` : '')],
            ['arms', (j.arms || []).join(', ')],
            ['shapes', (j.shapes || []).join(', ')],
            ['seeds', (j.seeds || []).join(', ')],
            ['rulesets', (j.rulesets || []).join(', ')],
            ['cells', job.cells ? `${job.cells.done}/${job.cells.total}` : String(this._cellCount(j))],
            ['games/cell', j.n ? `${j.n} (smoke)` : 'default'],
            ['commit', (j.head || '?') + (j.dirty ? ' + dirty tree' : '')],
            ['submitted', this._fmtTime(this._submitted(job))],
            ['finished', job.finishedAt || '—']
        ];
        const dl = wrap.appendChild(this._el('dl', 'lab-kv'));
        rows.forEach(([k, v]) => {
            dl.appendChild(this._el('dt', '', k));
            dl.appendChild(this._el('dd', '', v));
        });
        return wrap;
    },

    _metaEditor(job) {
        const wrap = this._el('div', 'lab-meta');
        wrap.appendChild(this._el('div', 'history-section-title', 'Purpose & reference'));
        const view = wrap.appendChild(this._purposeLine(job));
        const form = this._el('form', 'lab-meta-form');
        form.hidden = true;
        form.innerHTML =
            `<label>Purpose<textarea name="purpose" rows="2" maxlength="500"></textarea></label>` +
            `<label>Effort <input name="effort" placeholder="E41" maxlength="4" pattern="[Ee]\\d{2,3}" size="5"></label>`;
        form.purpose.value = (job.meta && job.meta.purpose) || '';
        form.effort.value = (job.meta && job.meta.effort) || '';
        const actions = form.appendChild(this._el('div', 'history-card-actions'));
        actions.appendChild(this._btn('Save', 'btn-primary btn-sm', () => form.requestSubmit()));
        actions.appendChild(this._btn('Cancel', 'btn-secondary btn-sm', () => { form.hidden = true; view.hidden = false; edit.hidden = false; }));
        form.addEventListener('submit', async e => {
            e.preventDefault();
            try {
                const r = await fetch(`/api/lab/jobs/${encodeURIComponent(job.id)}/meta`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ purpose: form.purpose.value, effort: form.effort.value })
                });
                const res = await r.json();
                if (!r.ok) throw new Error(res.error || r.status);
                showNotification('Saved', 'success');
                this.openJob(job.id);
                this._refresh();
            } catch (err) {
                showNotification(`Save failed: ${err.message}`, 'error');
            }
        });
        const edit = this._btn('✎ Edit', 'btn-secondary btn-sm lab-edit', () => {
            form.hidden = false; view.hidden = true; edit.hidden = true;
            form.purpose.focus();
        });
        wrap.appendChild(edit);
        wrap.appendChild(form);
        return wrap;
    },

    _resultsBlock(job) {
        const wrap = this._el('div', 'lab-results');
        wrap.appendChild(this._el('div', 'history-section-title', 'Results (arm − base)'));
        if (!job.report) {
            wrap.appendChild(this._el('div', 'lab-muted', this._isActive(job)
                ? 'Results land when every cell finishes.' : 'No report saved for this job.'));
            if (job.runLogTail && job.runLogTail.length) wrap.appendChild(this._el('pre', 'lab-pre', job.runLogTail.join('\n')));
            return wrap;
        }
        const cols = [['win', 'win'], ['capWin', 'cap'], ['dev%', 'dev%'], ['mono/srv', 'mono'], ['avgSteps', 'steps%']];
        (job.summary || []).forEach(s => {
            const top = s.arms.length ? s.arms[0].top : null;
            const cap = s.shape.toUpperCase() + (top ? ` · d${top}` : '') +
                (s.expected ? `  (${s.cells}/${s.expected} baseline cells)` : '  — no baseline cells');
            wrap.appendChild(this._el('div', 'lab-shape', cap));
            if (!s.arms.length) {
                if (s.cells) wrap.appendChild(this._el('div', 'lab-muted', 'Baseline only — no arm to compare.'));
                return;
            }
            const scroller = wrap.appendChild(this._el('div', 'lab-table-wrap'));
            const table = scroller.appendChild(this._el('table', 'lab-table'));
            table.innerHTML = `<thead><tr><th>arm</th>${cols.map(([, l]) => `<th>${this._esc(l)}</th>`).join('')}<th>gap</th></tr></thead>`;
            const tb = table.appendChild(this._el('tbody'));
            const notes = this._el('div', 'lab-cellnotes');
            s.arms.forEach(a => {
                const tr = tb.appendChild(this._el('tr'));
                tr.innerHTML = `<th>${this._esc(a.arm)}<span class="lab-sub">${a.cells} cells` +
                    (a.violations ? ` · <span class="lab-neg">${a.violations} viol</span>` : '') + `</span></th>` +
                    cols.map(([k]) => {
                        const v = a.metrics[k];
                        return `<td class="${this._tone(k, v)}">${v == null ? '—' : this._sgn(v)}</td>`;
                    }).join('') +
                    `<td>${a.gap ? `${this._sgn(a.gap.from)}→${this._sgn(a.gap.to)}<span class="lab-sub">wider ${a.gap.wider}/${a.gap.of}</span>` : '—'}</td>`;
                const per = a.perCell.map(c => `${this._esc(c.seed)}/${this._esc(c.rules)} <b class="${this._tone('win', c.delta)}">${this._sgn(c.delta)}</b>`).join(' · ');
                const arch = a.archetype ? Object.entries(a.archetype)
                    .map(([k, v]) => `${this._esc(k)} <b class="${this._tone('win', v)}">${this._sgn(v)}</b>`).join(' · ') : '';
                if (per || arch) {
                    const n = notes.appendChild(this._el('div'));
                    n.innerHTML = `<strong>${this._esc(a.arm)}</strong> ` +
                        (per ? `per-cell win: ${per}` : '') + (arch ? `<br>archetype win: ${arch}` : '');
                }
            });
            if (notes.childNodes.length) wrap.appendChild(notes);
        });
        return wrap;
    },

    /* ==================== Effort viewer ==================== */

    async openEffort(id) {
        let ef;
        try {
            const r = await fetch(`/api/lab/efforts/${encodeURIComponent(id)}`);
            ef = await r.json();
            if (!r.ok) throw new Error(ef.error || r.status);
        } catch (e) {
            showNotification(`Could not load ${id}: ${e.message}`, 'error');
            return;
        }
        const body = this._el('div', 'history-detail lab-detail');
        const head = body.appendChild(this._el('div', 'lab-effort-head'));
        head.appendChild(this._el('span', 'score-chip', ef.status || '?'));
        head.appendChild(this._el('span', 'lab-muted', ef.file));
        if (ef.headline) body.appendChild(this._el('p', 'lab-headline', ef.headline));
        const md = (ef.markdown || '').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
        body.appendChild(this._renderMd(md));
        Modals.show({
            title: `${ef.id} — ${ef.title || ''}`,
            body,
            buttons: [{ label: 'Close', class: 'btn-secondary' }]
        });
    },

    /* ==================== Markdown ==================== */

    /**
     * Minimal renderer for the docs/ai effort files: headings, paragraphs, (nested)
     * lists with 2-space continuation lines, pipe tables (indented ones attach to the
     * list item above), ``` fences, > quotes, and inline code / bold / italic / links.
     * Text is HTML-escaped before any inline markup is applied.
     */
    _renderMd(md) {
        const root = this._el('div', 'lab-md');
        const lines = md.split('\n');
        let para = null;        // open <p>
        let lists = [];         // stack of { el, indent }
        const lastLi = () => { const l = lists[lists.length - 1]; return l && l.el.lastElementChild; };
        const closeBlocks = () => { para = null; lists = []; };
        const isTableRow = (s) => /^\s*\|.*\|\s*$/.test(s);
        const isSep = (s) => /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(s);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const indent = line.match(/^ */)[0].length;
            const t = line.trim();

            if (!t) { closeBlocks(); continue; }

            if (t.startsWith('```')) {
                const code = [];
                while (++i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i]);
                const pre = this._el('pre', 'lab-pre', code.join('\n'));
                (indent && lastLi() ? lastLi() : root).appendChild(pre);
                para = null;
                continue;
            }

            const h = t.match(/^(#{1,6})\s+(.*)$/);
            if (h) {
                closeBlocks();
                const el = this._el(`h${Math.min(6, h[1].length + 2)}`, 'lab-md-h');
                el.innerHTML = this._mdInline(h[2]);
                root.appendChild(el);
                continue;
            }

            if (isTableRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
                const rows = [line];
                i++;
                while (i + 1 < lines.length && isTableRow(lines[i + 1])) rows.push(lines[++i]);
                const wrap = this._el('div', 'lab-table-wrap');
                const table = wrap.appendChild(this._el('table', 'lab-table'));
                rows.forEach((r, ri) => {
                    const tr = table.appendChild(this._el('tr'));
                    r.trim().replace(/^\||\|$/g, '').split('|').forEach(c => {
                        const cell = tr.appendChild(this._el(ri === 0 ? 'th' : 'td'));
                        cell.innerHTML = this._mdInline(c.trim());
                    });
                });
                const host = indent && lastLi();
                if (host) host.appendChild(wrap);
                else { closeBlocks(); root.appendChild(wrap); }
                para = null;
                continue;
            }

            const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
            if (li) {
                para = null;
                const ind = li[1].length;
                const tag = /\d/.test(li[2]) ? 'ol' : 'ul';
                while (lists.length && ind < lists[lists.length - 1].indent) lists.pop();
                let top = lists[lists.length - 1];
                if (!top || ind > top.indent) {
                    const el = this._el(tag, 'lab-md-list');
                    (top && lastLi() ? lastLi() : root).appendChild(el);
                    top = { el, indent: ind };
                    lists.push(top);
                }
                const item = top.el.appendChild(this._el('li'));
                item.innerHTML = this._mdInline(li[3]);
                continue;
            }

            if (indent && lists.length) {       // continuation of the last list item
                const item = lastLi();
                item.insertAdjacentHTML('beforeend', ' ' + this._mdInline(t));
                continue;
            }

            if (t.startsWith('>')) {
                closeBlocks();
                const q = this._el('blockquote', 'lab-md-quote');
                q.innerHTML = this._mdInline(t.replace(/^>\s?/, ''));
                root.appendChild(q);
                continue;
            }

            lists = [];
            if (!para) para = root.appendChild(this._el('p'));
            else para.insertAdjacentHTML('beforeend', ' ');
            para.insertAdjacentHTML('beforeend', this._mdInline(t));
        }

        // Links to sibling effort files open in the same viewer.
        root.querySelectorAll('a[data-effort]').forEach(a => a.addEventListener('click', (e) => {
            e.preventDefault();
            this.openEffort(a.dataset.effort);
        }));
        return root;
    },

    /** Inline markdown → HTML (escaped first; code spans are left untouched). */
    _mdInline(text) {
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        return text.split(/(`[^`]+`)/).map((part, idx) => {
            if (idx % 2) return `<code>${esc(part.slice(1, -1))}</code>`;
            return esc(part)
                .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
                    const ef = href.match(/^(E\d+)-[\w-]+\.md$/);
                    if (ef) return `<a href="#" data-effort="${ef[1]}">${label}</a>`;
                    if (/^https?:\/\//.test(href)) return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
                    return label;
                })
                .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
                .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<em>$2</em>');
        }).join('');
    },

    /* ==================== Helpers ==================== */

    /** In flight: a live watcher, or no watcher and no results in run.log yet. */
    _isActive(job) { return job.state === 'watching' || (job.state === 'unwatched' && !job.result); },

    /** Final outcome; a pre-watcher job (unwatched, results landed) takes its run.log result. */
    _outcome(job) {
        if (job.state === 'unwatched' && job.result) return job.result === 'success' ? 'success' : 'failure';
        return job.state;
    },

    _badge(job) {
        const st = this._outcome(job);
        const b = this._el('span', `lab-badge lab-badge-${st}`, this.STATE_LABEL[st] || st);
        return b;
    },

    _short(id) { return String(id).replace(/^\d{8}-\d{4}-/, ''); },

    _spec(j) {
        if (!j) return '';
        const n = j.n ? `  ·  n=${j.n} smoke` : '';
        return `${(j.arms || []).join(' / ')}  ·  ${(j.shapes || []).join(' ')}  ·  ` +
            `${(j.seeds || []).length} seed × ${(j.rulesets || []).join(' ')}${n}`;
    },

    _cellCount(j) {
        if (!j) return 0;
        return ['arms', 'shapes', 'seeds', 'rulesets'].reduce((p, k) => p * ((j[k] || []).length || 1), 1);
    },

    /** Epoch seconds: job.json `submitted`, else parsed from the id's YYYYMMDD-HHMM. */
    _submitted(job) {
        if (job.job && job.job.submitted) return job.job.submitted;
        const m = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)/.exec(job.id);
        return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000 : null;
    },

    _ago(sec) {
        if (!sec) return '';
        const m = Math.round((Date.now() / 1000 - sec) / 60);
        if (m < 60) return `${m} min ago`;
        if (m < 60 * 36) return `${Math.round(m / 60)} h ago`;
        return `${Math.round(m / 1440)} d ago`;
    },

    /** Local `YYYY-MM-DD hh:mm`, or just `hh:mm:ss` when clockOnly. */
    _fmtTime(sec, clockOnly) {
        if (!sec) return '—';
        const d = new Date(sec * 1000), p = n => String(n).padStart(2, '0');
        if (clockOnly) return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },

    _sgn(v) { return v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1); },

    _tone(metric, v) {
        if (v == null || v === 0 || !this.UP_GOOD.includes(metric)) return '';
        return v > 0 ? 'lab-pos' : 'lab-neg';
    },

    _el(tag, cls, text) {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (text !== undefined) el.textContent = text;
        return el;
    },

    _btn(label, cls, onClick) {
        const b = this._el('button', `btn ${cls}`, label);
        b.type = 'button';
        b.addEventListener('click', onClick);
        return b;
    },

    _esc(text) {
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    }
};

if (typeof window !== 'undefined') {
    window.LabUI = LabUI;
}
