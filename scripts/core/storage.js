/**
 * Core: Storage Manager
 *
 * Abstraction layer for localStorage operations with automatic
 * JSON parsing/stringification and error handling.
 *
 * Dependencies:
 *   - core/constants.js
 *
 * Exports:
 *   - window.StorageManager
 *
 * Used by:
 *   - core/state.js
 *   - All modules requiring data persistence
 */

/* ==================== STORAGE MANAGER CLASS ==================== */

class StorageManager {
    /**
     * Get a value from localStorage
     * @param {string} key - Storage key
     * @param {*} defaultValue - Default value if key doesn't exist
     * @returns {*} Parsed value or default
     */
    static get(key, defaultValue = null) {
        try {
            const stored = localStorage.getItem(key);
            if (stored === null) {
                return defaultValue;
            }
            return JSON.parse(stored);
        } catch (error) {
            console.error(`StorageManager.get error for key "${key}":`, error);
            return defaultValue;
        }
    }

    /**
     * Set a value in localStorage
     * @param {string} key - Storage key
     * @param {*} value - Value to store (will be JSON stringified)
     * @returns {boolean} True if successful
     */
    static set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            console.error(`StorageManager.set error for key "${key}":`, error);

            // Check for quota exceeded
            if (error.name === 'QuotaExceededError') {
                console.error('localStorage quota exceeded');
                if (typeof showNotification === 'function') {
                    showNotification('Storage full - please export your data', 'error');
                }
            }
            return false;
        }
    }

    /**
     * Remove a key from localStorage
     * @param {string} key - Storage key to remove
     * @returns {boolean} True if successful
     */
    static remove(key) {
        try {
            localStorage.removeItem(key);
            return true;
        } catch (error) {
            console.error(`StorageManager.remove error for key "${key}":`, error);
            return false;
        }
    }

    /**
     * Check if a key exists in localStorage
     * @param {string} key - Storage key
     * @returns {boolean} True if key exists
     */
    static has(key) {
        return localStorage.getItem(key) !== null;
    }

    /**
     * Get raw string value without parsing
     * @param {string} key - Storage key
     * @returns {string|null} Raw string value
     */
    static getRaw(key) {
        return localStorage.getItem(key);
    }

    /**
     * Set raw string value without stringifying
     * @param {string} key - Storage key
     * @param {string} value - String value to store
     * @returns {boolean} True if successful
     */
    static setRaw(key, value) {
        try {
            localStorage.setItem(key, value);
            return true;
        } catch (error) {
            console.error(`StorageManager.setRaw error for key "${key}":`, error);
            return false;
        }
    }

    /**
     * Get all keys in localStorage
     * @returns {string[]} Array of all keys
     */
    static getAllKeys() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            keys.push(localStorage.key(i));
        }
        return keys;
    }

    /**
     * Clear all data from localStorage
     * WARNING: This will remove ALL stored data
     * @returns {boolean} True if successful
     */
    static clearAll() {
        try {
            localStorage.clear();
            return true;
        } catch (error) {
            console.error('StorageManager.clearAll error:', error);
            return false;
        }
    }

    /**
     * Get approximate storage usage in bytes
     * @returns {number} Approximate bytes used
     */
    static getUsage() {
        let total = 0;
        for (let key in localStorage) {
            if (localStorage.hasOwnProperty(key)) {
                total += localStorage[key].length + key.length;
            }
        }
        return total * 2; // UTF-16 encoding = 2 bytes per character
    }
}

/* ==================== WINDOW EXPORTS ==================== */

if (typeof window !== 'undefined') {
    window.StorageManager = StorageManager;
}
