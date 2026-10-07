import {expect} from 'chai'

import {awsS3Endpoint} from '../../src/utils/proof-topology-init.js'

describe('proof topology AWS endpoints', () => {
  it('uses regional AWS endpoints including us-east-1 for the uploader safety probe', () => {
    expect(awsS3Endpoint('us-east-1')).to.equal('https://s3.us-east-1.amazonaws.com')
    expect(awsS3Endpoint('us-west-2')).to.equal('https://s3.us-west-2.amazonaws.com')
  })
})
