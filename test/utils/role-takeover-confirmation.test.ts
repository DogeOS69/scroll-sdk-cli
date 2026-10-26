import {expect} from 'chai'

import {type RoleTakeoverPreview, RoleTakeoverRequired} from '../../src/utils/aws-workload-role.js'
import {AwaitingInput} from '../../src/utils/preparation-io.js'
import {interactiveRoleTakeover, withRoleTakeoverConfirmation} from '../../src/utils/role-takeover-confirmation.js'

const preview = (): RoleTakeoverPreview => ({
  currentOwner: {ManagedBy: 'Terraform'}, currentTrust: {Statement: []}, desiredOwner: {ManagedBy: 'scrollsdk'},
  desiredPolicies: {'service-kms': {Statement: []}}, desiredTrust: {Statement: []}, inlinePoliciesToDelete: ['old-s3'],
  inlinePoliciesToReplace: [], managedPoliciesToDetach: ['arn:aws:iam::aws:policy/AmazonS3FullAccess'], permissionsBoundary: {},
  roleArn: 'arn:aws:iam::000000000000:role/fixture', roleId: 'old-role-id',
})

describe('operator confirmation for IAM role takeover', () => {
  it('waits without mutations when confirmation is absent or declined', async () => {
    for (const confirm of [undefined, async () => false, interactiveRoleTakeover(true)]) {
      let writes = 0
      let error: unknown
      try {
        await withRoleTakeoverConfirmation(approve => {
          if (!approve(preview())) throw new RoleTakeoverRequired(preview())
          writes++
        }, confirm)
      } catch (error_) {error = error_}

      expect(error).to.be.instanceOf(AwaitingInput)
      expect((error as AwaitingInput).details.message).to.include('Terraform').and.include('old-s3').and.include('without --json')
      expect(writes).to.equal(0)
    }
  })

  it('rechecks the observed role after confirmation and asks again if it was replaced', async () => {
    const role = preview()
    let prompts = 0
    let writes = 0
    await withRoleTakeoverConfirmation(approve => {
      if (!approve(role)) throw new RoleTakeoverRequired(structuredClone(role))
      writes++
    }, async () => {
      prompts++
      if (prompts === 1) role.roleId = 'replacement-role-id'
      return true
    })
    expect(prompts).to.equal(2)
    expect(writes).to.equal(1)
  })

  it('does not retain approval across separate attempts or catch unrelated errors', async () => {
    let prompts = 0
    const run = (approve: (value: RoleTakeoverPreview) => boolean) => {if (!approve(preview())) throw new RoleTakeoverRequired(preview())}
    for (let index = 0; index < 2; index++) await withRoleTakeoverConfirmation(run, async () => {prompts++; return true})
    expect(prompts).to.equal(2)
    let error: unknown
    try {await withRoleTakeoverConfirmation(() => {throw new Error('provider unavailable')}, async () => {throw new Error('must not prompt')})} catch (error_) {error = error_}
    expect(String(error)).to.include('provider unavailable')
  })
})
