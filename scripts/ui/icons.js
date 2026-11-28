/**
 * UI: Icons
 *
 * One inline-SVG line-icon set (24x24, stroke = currentColor) for the status
 * bar, the action buttons, modal buttons and the board's non-colour tiles.
 * The markup is static and trusted (never built from user input); it is
 * inline rather than a CSS mask because the CSP has no `data:` source.
 *
 * Icons.svg(name)         -> SVG markup ('' for an unknown name)
 * Icons.fromEmoji(emoji)  -> icon name for an emoji the UI used to show, or null
 * Icons.html(emoji)       -> SVG for that emoji, falling back to the emoji itself
 * Icons.label(el, label)  -> set a button's content from "<emoji> text":
 *                            a known leading emoji becomes its SVG
 * Icons.subtabs(aria, [[view, label, icon], ...], cls) -> a shared subtab bar
 *
 * Exports: window.Icons
 */

const Icons = {

    PATHS: {
        home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
        trade: '<path d="M4 8h15l-4-4"/><path d="M20 16H5l4 4"/>',
        dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h.01M15 9h.01M12 12h.01M9 15h.01M15 15h.01"/>',
        deed: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h7M9 16h7"/>',
        gavel: '<path d="M14 4l6 6-3 3-6-6z"/><path d="M12.5 8.5L4 17l3 3 8.5-8.5"/><path d="M13 21h8"/>',
        buy: '<circle cx="12" cy="12" r="9"/><path d="M12 6.5v11"/><path d="M14.6 9.6c-.5-.9-1.5-1.3-2.6-1.3-1.4 0-2.5.7-2.5 1.9 0 2.6 5 1.2 5 3.8 0 1.2-1.1 1.9-2.5 1.9-1.2 0-2.2-.5-2.7-1.4"/>',
        pay: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 10h.01M18 14h.01"/>',
        key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9"/><path d="M16 7l3 3M13.5 9.5l2 2"/>',
        bankrupt: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
        bank: '<path d="M3 10l9-6 9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 21h18"/>',
        next: '<path d="M5 5l9 7-9 7z"/><path d="M18 5v14"/>',
        forward: '<path d="M4 5l8 7-8 7z"/><path d="M13 5l8 7-8 7z"/>',
        stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
        refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 4v7h-7"/>',
        repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
        note: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
        log: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
        map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
        settings: '<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.5"/><circle cx="8" cy="17" r="2.5"/>',
        stats: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
        build: '<path d="M3 21h18"/><path d="M5 21V9l5-4 5 4v12"/><path d="M15 13h4v8"/><path d="M9 21v-5h2v5"/>',
        trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4c0 3 1.5 4.5 3.5 5M17 6h3c0 3-1.5 4.5-3.5 5"/><path d="M12 14v4M8 21h8M9 18h6"/>',
        // Dialog verbs
        check: '<path d="M4.5 12.5l5 5 10-11"/>',
        close: '<path d="M6 6l12 12M18 6L6 18"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        trash: '<path d="M4 7h16"/><path d="M10 7V4h4v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
        send: '<path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
        play: '<path d="M7 4l13 8-13 8z"/>',
        undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
        pause: '<path d="M8 5v14M16 5v14"/>',
        save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3"/><path d="M8 21v-7h8v7"/>',
        // Board tiles
        train: '<rect x="5" y="4" width="14" height="13" rx="2.5"/><path d="M5 11h14"/><path d="M9 14.5h.01M15 14.5h.01"/><path d="M8 17l-2 3M16 17l2 3"/>',
        bolt: '<path d="M13 2L5 14h6l-1 8 8-12h-6z"/>',
        drop: '<path d="M12 3c3.5 4.5 6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 2.5-6.5 6-11z"/>',
        percent: '<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>',
        gem: '<path d="M6 4h12l3 5-9 11L3 9z"/><path d="M3 9h18"/><path d="M9 4l3 5 3-5"/>',
        chest: '<path d="M4 10a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v8H4z"/><path d="M4 12h16"/><path d="M12 11v3"/>',
        question: '<path d="M8.5 9a3.5 3.5 0 1 1 5.3 3c-1.1.7-1.8 1.3-1.8 2.5"/><path d="M12 18.5h.01"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.5h.01"/>',
        // Subtab icons (paths from the shared .shared/js/icons.js set)
        history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
        flask: '<path d="M9 3h6M10 3v7.4L4.6 19a1.5 1.5 0 0 0 1.3 2h12.2a1.5 1.5 0 0 0 1.3-2L14 10.4V3"/><path d="M7 16h10"/>',
        cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
        user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
        eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
        bot: '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 16h.01M16 16h.01"/>',
        lightbulb: '<path d="M9 18h6M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>',
        activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'
    },

    // The emoji each surface used before the icon set
    EMOJI: {
        '🏠': 'home', '🤝': 'trade', '🎲': 'dice', '📋': 'deed', '🔨': 'gavel',
        '💰': 'buy', '💵': 'pay', '🔑': 'key', '💀': 'bankrupt', '🏦': 'bank',
        '⏭': 'next', '⏩': 'forward', '⏹': 'stop', '🔄': 'refresh', '🔁': 'repeat',
        '📝': 'note', '📜': 'log', '🗺': 'map', '⚙': 'settings', '📊': 'stats',
        '🏗': 'build', '🏆': 'trophy',
        '✅': 'check', '✔': 'check', '✕': 'close', '✖': 'close', '➕': 'plus', '＋': 'plus',
        '🗑': 'trash', '📤': 'send', '▶': 'play', '↩': 'undo', '💾': 'save', '⏸': 'pause', 'ⓘ': 'info', 'ℹ': 'info'
    },

    svg(name) {
        const inner = this.PATHS[name];
        if (!inner) return '';
        return `<svg class="icon icon-${name}" viewBox="0 0 24 24" width="1em" height="1em" fill="none" ` +
            `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
            `aria-hidden="true" focusable="false">${inner}</svg>`;
    },

    fromEmoji(emoji) {
        // Some emoji arrive with a variation selector (U+FE0F)
        const key = String(emoji || '').replace(/️/g, '');
        return Object.prototype.hasOwnProperty.call(this.EMOJI, key) ? this.EMOJI[key] : null;
    },

    html(emoji) {
        const name = this.fromEmoji(emoji);
        return name ? this.svg(name) : this._esc(emoji);
    },

    /** Button content from a label that may start with an emoji ("🗺 Owners"). */
    label(el, label) {
        const text = String(label);
        const cut = text.indexOf(' ');
        const name = cut > 0 ? this.fromEmoji(text.slice(0, cut)) : null;
        if (!name) { el.textContent = text; return; }
        el.innerHTML = this.svg(name);
        el.appendChild(document.createTextNode(' ' + text.slice(cut + 1)));
    },

    /** Markup for a shared subtab bar (.shared/README.md "Subtabs"): one button per
     *  [view, label, icon], icon over label on cover/internal. Trusted strings only. */
    subtabs(ariaLabel, items, cls) {
        return `<div class="ui-seg ui-subtabs${cls ? ' ' + cls : ''}" role="group" aria-label="${this._esc(ariaLabel)}">` +
            items.map(([view, label, icon]) =>
                `<button type="button" data-view="${view}">${this.svg(icon)}<span>${this._esc(label)}</span></button>`).join('') +
            '</div>';
    },

    _esc(s) {
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }
};

if (typeof window !== 'undefined') {
    window.Icons = Icons;
}
