'use strict';

function normalizeInteger(value, { min = 0 } = {}) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : null;
}

function normalizeSimSlot(value) {
    return normalizeInteger(value, { min: 0 });
}

function extractSimScope(source = {}) {
    return {
        simSlot: normalizeSimSlot(
            source?.simSlot
            ?? source?.sim_slot
            ?? source?.slotIndex
            ?? source?.slot_index
        )
    };
}

function resolveRequestSimScope(req) {
    const queryScope = extractSimScope(req?.query || {});
    const bodyScope = extractSimScope(req?.body || {});
    return {
        simSlot: queryScope.simSlot ?? bodyScope.simSlot ?? null
    };
}

function hasSimScope(scope = {}) {
    return scope.simSlot !== null;
}

function buildSimScopeClause(scope = {}, options = {}) {
    const alias = String(options.alias || '').trim();
    const slotColumn = alias ? `${alias}.${options.slotColumn || 'sim_slot'}` : (options.slotColumn || 'sim_slot');
    const includeUnknown = options.includeUnknown === true;
    const clauses = [];
    const params = [];

    if (scope.simSlot !== null) {
        clauses.push(includeUnknown
            ? `(${slotColumn} = ? OR ${slotColumn} IS NULL)`
            : `${slotColumn} = ?`);
        params.push(scope.simSlot);
    }

    return {
        clause: clauses.length ? clauses.join(' AND ') : '',
        params
    };
}

function appendSimScopeCondition(conditions, params, scope, options = {}) {
    const scoped = buildSimScopeClause(scope, options);
    if (scoped.clause) {
        conditions.push(scoped.clause);
        params.push(...scoped.params);
    }
    return scoped;
}

module.exports = {
    normalizeSimSlot,
    extractSimScope,
    resolveRequestSimScope,
    hasSimScope,
    buildSimScopeClause,
    appendSimScopeCondition
};
