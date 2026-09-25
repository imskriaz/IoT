const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/main.js'), 'utf8');
const themeCode = source.slice(source.indexOf('// Theme preference ('), source.indexOf('// Export functions for use in other files'));
const layout = fs.readFileSync(path.join(__dirname, '../views/layouts/main.html'), 'utf8');
const prepaint = layout.match(/<script>([\s\S]*?)<\/script>/)[1];

function harness(mode = 'system', dark = false, saved = null) {
    const attrs = { 'data-theme-preference': mode };
    const button = { setAttribute: jest.fn() };
    const icon = {};
    const query = { matches: dark, addEventListener: jest.fn() };
    const root = { style: {}, getAttribute: key => attrs[key], setAttribute: (key, value) => { attrs[key] = value; } };
    const context = {
        document: { documentElement: root, getElementById: id => id === 'darkModeIcon' ? icon : button },
        window: { matchMedia: () => query },
        localStorage: { getItem: () => saved, setItem: jest.fn() },
        fetch: jest.fn().mockResolvedValue({ ok: true })
    };
    vm.createContext(context);
    vm.runInContext(prepaint, context);
    vm.runInContext(themeCode, context);
    return { context, attrs, query, root, button, icon };
}

test('system defaults resolve before styles and follow OS changes', () => {
    const h = harness('system', true);
    expect(h.attrs['data-bs-theme']).toBe('dark');
    expect(h.root.style.colorScheme).toBe('dark');
    h.query.matches = false;
    h.query.addEventListener.mock.calls[0][1]();
    expect(h.attrs['data-bs-theme']).toBe('light');
    expect(h.attrs['data-theme-preference']).toBe('system');
    expect(layout.indexOf('<script>')).toBeLessThan(layout.indexOf('<link'));
});

test('existing control cycles and persists all three modes with accessible labels', () => {
    const h = harness();
    for (const mode of ['light', 'dark', 'system']) {
        h.context.window.toggleDarkMode();
        expect(h.attrs['data-theme-preference']).toBe(mode);
        expect(h.context.localStorage.setItem).toHaveBeenLastCalledWith('theme', mode);
        expect(JSON.parse(h.context.fetch.mock.calls.at(-1)[1].body)).toEqual({ theme: mode });
        expect(h.button.setAttribute).toHaveBeenCalledWith('aria-label', expect.stringContaining(`Theme: ${mode}.`));
    }
});

test('explicit preferences ignore OS changes and saved preference survives reload', () => {
    const h = harness('system', true, 'light');
    h.query.addEventListener.mock.calls[0][1]();
    expect(h.attrs['data-bs-theme']).toBe('light');
    expect(h.attrs['data-theme-preference']).toBe('light');
});

test('blocked local storage does not prevent prepaint or theme application', () => {
    const h = harness();
    h.context.localStorage.getItem = () => { throw new Error('blocked'); };
    h.context.localStorage.setItem = () => { throw new Error('blocked'); };
    expect(() => vm.runInContext(prepaint, h.context)).not.toThrow();
    expect(() => h.context.window.toggleDarkMode()).not.toThrow();
    expect(h.attrs['data-bs-theme']).toBe('light');
});
