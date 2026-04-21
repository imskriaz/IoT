function parseUssdMenuOptions(response) {
    const text = String(response || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();
    const options = [];
    const seen = new Set();

    if (!text) {
        return options;
    }

    text.split('\n').forEach((line) => {
        const match = String(line || '')
            .trim()
            .match(/^(\d{1,2})(?:\s*[\.\):-]|\s+)(.+)$/);
        if (!match) {
            return;
        }

        const option = String(match[1] || '').trim();
        const label = String(match[2] || '').trim();
        if (!option || !label || seen.has(option)) {
            return;
        }

        seen.add(option);
        options.push({ option, label });
    });

    return options;
}

module.exports = {
    parseUssdMenuOptions
};
