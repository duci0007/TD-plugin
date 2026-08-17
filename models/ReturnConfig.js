import fs from 'fs'
import { isFileExist } from './isFileExist.js'
import axios from 'axios'
import cfg from '../../../lib/config/config.js'

let DATA_PATH = `${process.cwd()}/plugins/TD-plugin/config/TeyvatConfig/TeyvatUrlJson.json`
let ONE_PATH = `${process.cwd()}/plugins/TD-plugin/config/TeyvatConfig`

async function ReturnConfig () {
  let PATH = DATA_PATH.replace(/\\/g, '/')
  if (!fs.existsSync(ONE_PATH)) {
    logger.info('>>>[TD-plugin]已创建TeyvatConfig文件夹')
    fs.mkdirSync(ONE_PATH)
  }
  if (!await isFileExist(DATA_PATH)) {
    fs.writeFileSync(DATA_PATH, '{}')
  }
  let DATA_JSON = JSON.parse(fs.readFileSync(PATH))
  if (!DATA_JSON.CHAR_DATA || !DATA_JSON.HASH_TRANS || !DATA_JSON.CALC_RULES || !DATA_JSON.RELIC_APPEND) {
    await GetJson(PATH)
  }
  return await JSON.parse(fs.readFileSync(PATH))
}

async function GetJson (PATH) {
  let DATA_JSON = JSON.parse(fs.readFileSync(PATH))
  let Error = null
  let CHAR_DATA = await LocalUpdateJson('https://cdn.monsterx.cn/bot/gspanel/char-data.json')
  if (!CHAR_DATA) {
    console.log('CHAR_DATA请求失败')
    Error += `CHAR_DATA、`
  } else {
    DATA_JSON.CHAR_DATA = CHAR_DATA
  }
  let HASH_TRANS = await LocalUpdateJson('https://cdn.monsterx.cn/bot/gspanel/hash-trans.json')
  if (!HASH_TRANS) {
    Error += `HASH_TRANS、`
    console.log('HASH_TRANS请求失败')
  } else {
    DATA_JSON.HASH_TRANS = HASH_TRANS
  }
  let CALC_RULES = await LocalUpdateJson('https://cdn.monsterx.cn/bot/gspanel/calc-rule.json')
  if (!CALC_RULES) {
    console.log('CALC_RULES请求失败')
  } else {
    DATA_JSON.CALC_RULES = CALC_RULES
  }
  let RELIC_APPEND = await LocalUpdateJson('https://cdn.monsterx.cn/bot/gspanel/relic-append.json')
  if (!RELIC_APPEND) {
    Error += `RELIC_APPEND、`
    console.log('RELIC_APPEND请求失败')
  } else {
    DATA_JSON.RELIC_APPEND = RELIC_APPEND
  }
  if (Error) {
    try {
      await Bot.pickFriend(cfg.masterQQ[0]).sendMsg(`[TD-plugin]：队伍伤害${Error}请求失败，您的网络似乎有点问题?`)
    } catch (err) {
      logger.error(`[TD-plugin]队伍伤害${Error}请求失败`)
    }
  }
  fs.writeFileSync(PATH, JSON.stringify(DATA_JSON))
}

async function LocalUpdateJson (URL) {
  try {
    const res = await axios.get(URL)
    return res.data
  } catch (error) {
    console.log(`${URL}请求失败...`)
    console.error(error)
    return null
  }
}

export default ReturnConfig
