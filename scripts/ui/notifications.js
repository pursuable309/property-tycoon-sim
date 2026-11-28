/**
 * Shared Notifications JS
 *
 * Canonical copy: <projects>/.shared/js/notifications.js
 * Don't edit a project's copy. Edit the canonical file, then run
 * `python3 .scripts/sync_shared.py --apply` (copies are listed in .shared/manifest.json).
 *
 * Usage:
 *   showNotification('Success!', 'success');
 *   showNotification('Error occurred', 'error');
 *   showNotification('Warning...', 'warning');
 *   showNotification('Info message', 'info');
 *
 * Icons are inline SVG (stroke = currentColor), so no icon font is required.
 */

(function() {
    'use strict';

    var SVG_OPEN = '<svg class="notification-icon" viewBox="0 0 16 16" width="18" height="18" ' +
        'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true" focusable="false">';

    var icons = {
        success: SVG_OPEN + '<circle cx="8" cy="8" r="6.75"/><path d="M5 8.25l2 2 4-4.25"/></svg>',
        error: SVG_OPEN + '<circle cx="8" cy="8" r="6.75"/><path d="M8 4.75v3.75M8 11.25v.01"/></svg>',
        warning: SVG_OPEN + '<path d="M8 1.9L15 14H1z"/><path d="M8 6.25v3.5M8 11.9v.01"/></svg>',
        info: SVG_OPEN + '<circle cx="8" cy="8" r="6.75"/><path d="M8 7.25v4M8 4.9v.01"/></svg>'
    };

    /**
     * Show a notification
     * @param {string} message - Message to display (plain text; HTML is escaped)
     * @param {string} type - 'success', 'error', 'warning', 'info' (default 'info')
     */
    function showNotification(message, type) {
        type = type || 'info';

        // Validate type
        if (!icons[type]) {
            type = 'info';
        }

        // Create notification element
        var notification = document.createElement('div');
        notification.className = 'notification ' + type;

        // Add icon and message
        notification.innerHTML = icons[type] + '<span>' + escapeHtml(message) + '</span>';

        // Add to document
        document.body.appendChild(notification);

        // Trigger show animation
        setTimeout(function() {
            notification.classList.add('show');
        }, 10);

        // Auto-hide after 3 seconds
        setTimeout(function() {
            notification.classList.remove('show');

            // Remove from DOM after animation
            setTimeout(function() {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 3000);
    }

    /**
     * Escape HTML to prevent XSS
     */
    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Export to window
    window.showNotification = showNotification;

})();
