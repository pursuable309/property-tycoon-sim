/**
 * UI: Style (visual style, independent of Light / Dark)
 *
 * Loaded in <head> right after theme.js so the saved style is on <html>
 * before the first paint. A style is a token set in styles/themes/style-*.css
 * keyed on html[data-style]; "banker" is the default look and sets no
 * attribute. Each style also owns the browser bar colour (the <meta
 * name="theme-color"> data-light / data-dark pair theme.js paints from).
 *
 * Style.get()        -> saved style id (monopoly_settings.style)
 * Style.apply(id?)   -> put a style on <html> (default: the saved one)
 * Style.STYLES       -> { id: { label, light, dark } }
 *
 * Exports: window.Style
 */
(function () {
    'use strict';
    var KEY = 'monopoly_settings';
    // light / dark: the top bar colour (--brand) of that mode
    var STYLES = {
        banker: { label: 'Banker', light: '#ECE3D0', dark: '#1F1810' },
        classic: { label: 'Classic', light: '#FFFFFF', dark: '#161A20' },
        felt: { label: 'Felt', light: '#E9DFC6', dark: '#1D130B' },
        newsprint: { label: 'Newsprint', light: '#FAF8F1', dark: '#191918' },
        contrast: { label: 'Contrast', light: '#FFFFFF', dark: '#000000' }
    };

    function clean(id) {
        return Object.prototype.hasOwnProperty.call(STYLES, id) ? id : 'banker';
    }

    function get() {
        try {
            var o = JSON.parse(localStorage.getItem(KEY) || 'null');
            return clean(o && typeof o === 'object' ? o.style : null);
        } catch (e) { return 'banker'; }
    }

    function apply(id) {
        var style = clean(id === undefined ? get() : id);
        var root = document.documentElement;
        if (style === 'banker') root.removeAttribute('data-style');
        else root.setAttribute('data-style', style);
        var meta = document.querySelector('meta[name="theme-color"][data-light]');
        if (meta) {
            meta.setAttribute('data-light', STYLES[style].light);
            meta.setAttribute('data-dark', STYLES[style].dark);
        }
        if (window.Theme) window.Theme.refresh(); // repaints the meta colour
        return style;
    }

    window.Style = { STYLES: STYLES, get: get, apply: apply, current: function () { return clean(document.documentElement.getAttribute('data-style')); } };
    apply();
})();
