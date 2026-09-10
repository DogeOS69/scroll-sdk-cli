import { expect } from 'chai'

import { validateCubesignerRolePrefix } from '../../src/utils/cubesigner-role-name.js'

describe('CubeSigner role prefix validation before key creation', () => {
    it('accepts conservative provider-safe prefixes', () => {
        for (const prefix of ['tee', 'devnet_20260910_b_tee', 'TEE01']) {
            expect(() => validateCubesignerRolePrefix(prefix)).not.to.throw()
        }
    })

    it('rejects hyphens, whitespace and shell metacharacters', () => {
        for (const prefix of ['', 'tee-devnet', 'tee devnet', 'tee\n', 'tee"', 'tee$(id)', 'tee`id`', '测试']) {
            expect(() => validateCubesignerRolePrefix(prefix)).to.throw('only ASCII letters, digits and underscores')
        }
    })
})
