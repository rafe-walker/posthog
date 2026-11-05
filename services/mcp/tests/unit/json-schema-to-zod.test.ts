import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { generateZodFromSchemaRef, getEntryVarName } from '../../scripts/lib/json-schema-to-zod'

describe('generateZodFromSchemaRef — array constraints', () => {
    it.each([
        { label: 'minItems only', constraints: { minItems: 2 }, expected: 'z.array(z.string()).min(2)' },
        { label: 'maxItems only', constraints: { maxItems: 5 }, expected: 'z.array(z.string()).max(5)' },
        {
            label: 'minItems and maxItems together',
            constraints: { minItems: 1, maxItems: 3 },
            expected: 'z.array(z.string()).min(1).max(3)',
        },
    ])('propagates $label to the generated Zod array', ({ constraints, expected }) => {
        const root = {
            definitions: {
                Subject: {
                    type: 'object',
                    properties: {
                        items: {
                            type: 'array',
                            items: { type: 'string' },
                            ...constraints,
                        },
                    },
                },
            },
        }

        const out = generateZodFromSchemaRef(root, 'Subject')

        expect(out).toContain(expected)
    })

    it('emits a bare z.array() when no array constraints are present', () => {
        const root = {
            definitions: {
                Plain: {
                    type: 'object',
                    properties: {
                        items: { type: 'array', items: { type: 'string' } },
                    },
                },
            },
        }

        const out = generateZodFromSchemaRef(root, 'Plain')

        expect(out).toContain('z.array(z.string())')
        expect(out).not.toMatch(/\.min\(/)
        expect(out).not.toMatch(/\.max\(/)
    })
})

describe('generateZodFromSchemaRef — union primitive strictness', () => {
    // Coercing branches inside a union are greedy (z.coerce.boolean() accepts any
    // input, z.coerce.number() turns null into 0), which made later array/null
    // branches unreachable: a `["host.com"]` property-filter value parsed as `true`
    // and a feature-flag variant string parsed as `true`. Union members must be strict.
    it.each([
        {
            label: 'anyOf of primitives',
            schema: {
                anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
            },
            expected: 'z.union([z.string(), z.number(), z.boolean()])',
        },
        {
            label: 'anyOf with array and null branches',
            schema: {
                anyOf: [
                    { anyOf: [{ type: 'string' }, { type: 'number' }] },
                    { type: 'array', items: { type: 'string' } },
                    { type: 'null' },
                ],
            },
            expected: 'z.union([z.union([z.string(), z.number()]), z.array(z.string()), z.null()])',
        },
        {
            label: 'multi-type array',
            schema: { type: ['string', 'boolean'] },
            expected: 'z.union([z.string(), z.boolean()])',
        },
    ])('emits strict primitives for $label', ({ schema, expected }) => {
        const root = { definitions: { Subject: { type: 'object', properties: { value: schema } } } }

        const out = generateZodFromSchemaRef(root, 'Subject')

        expect(out).toContain(expected)
        expect(out).not.toContain('z.coerce')
    })
})

describe('generateZodFromSchemaRef — lone primitive fields', () => {
    function parseWith(property: object, input: unknown): unknown {
        const root = {
            definitions: {
                integer: { type: 'integer' },
                Subject: { type: 'object', properties: { value: property }, required: ['value'] },
            },
        }
        const code = `${generateZodFromSchemaRef(root, 'Subject')}\nreturn ${getEntryVarName('Subject')}`
        // Run the emitted source, so that each case checks what a generated tool accepts, not the emitted text.
        const schema = new Function('z', code)(z) as z.ZodType
        const result = schema.safeParse({ value: input })
        return result.success ? result.data : 'rejected'
    }

    it.each([
        ['boolean', 'false', { type: 'boolean' }, 'rejected'],
        ['boolean', false, { type: 'boolean' }, { value: false }],
        ['number', null, { type: 'number' }, 'rejected'],
        ['number', '', { type: 'number' }, 'rejected'],
        ['number', 1.5, { type: 'number' }, { value: 1.5 }],
        ['nullable integer', null, { type: ['integer', 'null'] }, { value: null }],
        [
            'integer-or-null union',
            null,
            { anyOf: [{ $ref: '#/definitions/integer' }, { type: 'null' }] },
            { value: null },
        ],
        ['integer-or-null union', '', { anyOf: [{ $ref: '#/definitions/integer' }, { type: 'null' }] }, 'rejected'],
    ] as const)('%s field given %j', (_label, input, property, expected) => {
        expect(parseWith(property, input)).toEqual(expected)
    })
})
