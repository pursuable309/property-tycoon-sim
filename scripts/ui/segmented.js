/**
 * UI: Segmented control
 *
 * A single-select pill group — a touch-friendly stand-in for a native <select>
 * when the option count is small (≈2–5). Renders as radio inputs (so keyboard
 * and form semantics come for free) styled as a connected row of buttons,
 * matching the shared toggle switch and log chips.
 *
 * Exports: window.Segmented
 *   Segmented.html(name, options, value, ariaLabel, cls) -> HTML string
 *   Segmented.el(name, options, value, ariaLabel, cls)   -> HTMLElement
 *   Segmented.value(scope, name)                    -> selected value | null
 *   Segmented.set(scope, name, value)               -> check a value, fire change
 *
 * `options` is an array of [value, label] pairs; label may contain emoji/HTML.
 * `name` groups the radios — must be unique per live control on the page (for
 * repeated rows, suffix it, e.g. `seat-type-${i}`). `cls` adds classes to the
 * group: `is-scroll` keeps pills at their natural width and scrolls the row
 * sideways instead of clipping labels (view switchers, filters).
 */
const Segmented = {

    html(name, options, value, ariaLabel, cls) {
        const group = ariaLabel ? ` aria-label="${this._attr(ariaLabel)}"` : '';
        const opts = options.map(([v, text]) => {
            const checked = String(value) === String(v) ? ' checked' : '';
            return `<label class="segmented-opt">` +
                `<input type="radio" name="${this._attr(name)}" value="${this._attr(v)}"${checked}>` +
                `<span>${text}</span></label>`;
        }).join('');
        const extra = cls ? ' ' + this._attr(cls) : '';
        return `<div class="segmented${extra}" role="radiogroup"${group}>${opts}</div>`;
    },

    el(name, options, value, ariaLabel, cls) {
        const holder = document.createElement('div');
        holder.innerHTML = this.html(name, options, value, ariaLabel, cls);
        return holder.firstElementChild;
    },

    /** Selected value within `scope` (an element or document), or null. */
    value(scope, name) {
        const sel = (scope || document).querySelector(`input[name="${CSS.escape(name)}"]:checked`);
        return sel ? sel.value : null;
    },

    /** Programmatically select `value`, firing a bubbling change event. */
    set(scope, name, value) {
        const target = (scope || document).querySelector(
            `input[name="${CSS.escape(name)}"][value="${CSS.escape(String(value))}"]`);
        if (target) { target.checked = true; target.dispatchEvent(new Event('change', { bubbles: true })); }
    },

    _attr(s) { return String(s).replace(/"/g, '&quot;'); }
};

if (typeof window !== 'undefined') window.Segmented = Segmented;
