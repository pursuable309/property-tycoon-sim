/**
 * UI: AI Tuning editor
 *
 * Editor over the AITuning knob registry: grouped number inputs with the
 * default shown alongside, per-row reset, Save and Reset all. Changes are
 * clamped by the registry and take effect for the next game (personality
 * weights and difficulty params are read live through AITuning.merged).
 *
 * render(container) draws it inline (the Lab tab's Tuning view) with a
 * pinned Save / Reset all bar (the one way in; the old modal open() had no caller).
 *
 * Dependencies: tuning, modals, notifications
 * Exports: window.TuningUI
 */

const TuningUI = {

    /** The grouped knob rows (no buttons). */
    _build() {
        const registry = AITuning.registry();
        const body = document.createElement('div');
        body.className = 'tuning-body';

        const groups = {};
        Object.keys(registry).forEach(path => {
            (groups[registry[path].group] = groups[registry[path].group] || []).push(path);
        });

        Object.keys(groups).forEach(groupName => {
            const title = document.createElement('div');
            title.className = 'tuning-group-title';
            title.textContent = groupName;
            body.appendChild(title);

            groups[groupName].forEach(path => {
                const reg = registry[path];
                const row = document.createElement('div');
                row.className = 'tuning-row';
                row.dataset.path = path;

                const label = document.createElement('label');
                label.textContent = reg.label;
                label.title = path;
                row.appendChild(label);

                if (reg.desc) {
                    const info = document.createElement('button');
                    info.type = 'button';
                    info.className = 'tuning-info';
                    info.innerHTML = Icons.svg('info');
                    info.title = reg.desc;
                    info.setAttribute('aria-label', `What is ${reg.label}?`);
                    row.appendChild(info);
                }

                const def = document.createElement('span');
                def.className = 'tuning-default';
                def.textContent = `(${reg.def})`;
                def.title = 'default';
                row.appendChild(def);

                const input = document.createElement('input');
                input.type = 'number';
                input.min = reg.min;
                input.max = reg.max;
                input.step = reg.step;
                input.value = AITuning.get(path);
                input.setAttribute('aria-label', reg.label);
                row.appendChild(input);

                const reset = document.createElement('button');
                reset.type = 'button';
                reset.className = 'tuning-reset';
                reset.innerHTML = Icons.svg('undo');
                reset.title = 'reset to default';
                reset.setAttribute('aria-label', `Reset ${reg.label} to default`);
                row.appendChild(reset);

                const sync = () => row.classList.toggle('is-changed', Number(input.value) !== reg.def);
                input.addEventListener('input', sync);
                reset.addEventListener('click', () => { input.value = reg.def; sync(); });
                sync();

                body.appendChild(row);

                // Tap-to-toggle description (hover tooltips don't exist on touch)
                if (reg.desc) {
                    const desc = document.createElement('div');
                    desc.className = 'tuning-desc';
                    desc.textContent = reg.desc;
                    desc.hidden = true;
                    row.querySelector('.tuning-info').addEventListener('click', () => {
                        desc.hidden = !desc.hidden;
                    });
                    body.appendChild(desc);
                }
            });
        });
        return body;
    },

    /** Store every row's value (clamped by the registry); toast the result. */
    _save(body) {
        let changed = 0;
        body.querySelectorAll('.tuning-row').forEach(row => {
            const path = row.dataset.path;
            const value = Number(row.querySelector('input').value);
            if (!isFinite(value)) return;
            if (value !== AITuning.get(path)) changed += 1;
            AITuning.set(path, value);
        });
        const n = Object.keys(AITuning.overrides()).length;
        showNotification(changed
            ? `Saved: ${n} knob${n === 1 ? '' : 's'} overridden (applies to new games)`
            : 'No changes', changed ? 'success' : 'info');
    },

    _resetAll() {
        AITuning.reset();
        showNotification('All tuning reset to defaults', 'info');
    },

    /** Inline editor (Lab → Tuning) with a pinned Save / Reset all bar. */
    render(container) {
        const n = Object.keys(AITuning.overrides()).length;
        const intro = document.createElement('div');
        intro.className = 'lab-intro';
        intro.textContent = `Knobs for the CPU AI. Changes apply to games started after you save. ` +
            `${n ? `${n} knob${n === 1 ? ' is' : 's are'} overridden (green rows).` : 'All knobs are at their defaults.'}`;
        container.appendChild(intro);
        const body = this._build();
        body.classList.add('tuning-inline');
        container.appendChild(body);

        const bar = document.createElement('div');
        bar.className = 'tuning-bar';
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'btn btn-quiet';
        Icons.label(reset, '↩ Reset all');
        // Two taps: a stray tap shouldn't wipe every override
        Modals.armConfirm(reset, 'Tap again to reset', () => {
            this._resetAll();
            container.textContent = '';
            this.render(container);
        });
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'btn btn-primary';
        Icons.label(save, '✅ Save');
        save.addEventListener('click', () => {
            this._save(body);
            container.textContent = '';
            this.render(container);
        });
        bar.append(reset, save);
        container.appendChild(bar);
    }
};

if (typeof window !== 'undefined') {
    window.TuningUI = TuningUI;
}
