import { getConfig } from '@summer-js/summer'
import { initTest, endTest, request } from '@summer-js/test'

describe('Config Test', () => {
  beforeAll(async () => {
    await initTest()
  })

  afterAll(async () => {
    await endTest()
  })

  test('test getConfig', async () => {
    const config = getConfig()['TEST_CONFIG']
    expect(JSON.stringify(config)).toEqual(
      JSON.stringify({
        var1: 'VAR1Change',
        var2: ['A1', 'B2'],
        var3: 'VAR3'
      })
    )
  })
})
