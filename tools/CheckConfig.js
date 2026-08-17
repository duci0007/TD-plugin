import fs from 'fs'
import { isFileExist } from '../models/isFileExist.js'
import axios from 'axios'

let cwd = process.cwd().replace(/\\/g, '/')
let TeyvatPath = `${cwd}/plugins/TD-plugin/config/TeyvatConfig/TeyvatUrlJson.json`
let TeyvatFolderPath = `${cwd}/plugins/TD-plugin/config/TeyvatConfig`

export async function CheckConfig () {
  if (!fs.existsSync(TeyvatFolderPath)) {
    fs.mkdirSync(TeyvatFolderPath, { recursive: true })
  }
  if (!await isFileExist(TeyvatPath)) {
    fs.writeFileSync(TeyvatPath, '{}')
    logger.info(logger.magenta('[TD-plugin]>>已创建TeyvatUrlJson.json资源文件'))
  }
  // 检查是否需要下载配置项
  let needDownload = false
  try {
    let DATA_JSON = JSON.parse(fs.readFileSync(TeyvatPath))
    if (!DATA_JSON.CHAR_DATA || !DATA_JSON.HASH_TRANS || !DATA_JSON.CALC_RULES || !DATA_JSON.RELIC_APPEND) {
      needDownload = true
    }
  } catch (err) {
    needDownload = true
  }
  if (needDownload) {
    logger.info(logger.magenta('[TD-plugin]>>将在10s后开始请求队伍伤害所需JSON'))
    setTimeout(async () => {
      await DownloadTeyvatJson()
    }, 10000)
  } else {
    logger.info(logger.magenta('[TD-plugin]>>队伍伤害配置项已就绪'))
  }
}

async function DownloadTeyvatJson () {
  let DATA_JSON = JSON.parse(fs.readFileSync(TeyvatPath))
  let Error = null
  try {
    let CHAR_DATA = await LocalUpdateJson('https://cdn.monsterx.cn/bot/gspanel/char-data.json')
    if (!CHAR_DATA) {
      logger.info(logger.red('CHAR_DATA请求失败'))
      Error += `CHAR_DATA、`
    } else {
      DATA_JSON.CHAR_DATA = CHAR_DATA
    }
    let HASH_TRANS = await LocalUpdateJson('https://cdn.monsterx.cn/bot/gspanel/hash-trans.json')
    if (!HASH_TRANS) {
      Error += `HASH_TRANS、`
      logger.info(logger.red('HASH_TRANS请求失败'))
    } else {
      DATA_JSON.HASH_TRANS = HASH_TRANS
    }
    let CALC_RULES = await LocalUpdateJson('https://cdn.monsterx.cn/bot/gspanel/calc-rule.json')
    if (!CALC_RULES) {
      Error += `CALC_RULES、`
      logger.info(logger.red('CALC_RULES请求失败'))
    } else {
      DATA_JSON.CALC_RULES = CALC_RULES
    }
    let RELIC_APPEND = await LocalUpdateJson('https://cdn.monsterx.cn/bot/gspanel/relic-append.json')
    if (!RELIC_APPEND) {
      Error += `RELIC_APPEND、`
      logger.info(logger.red('RELIC_APPEND请求失败'))
    } else {
      DATA_JSON.RELIC_APPEND = RELIC_APPEND
    }
    fs.writeFileSync(TeyvatPath, JSON.stringify(DATA_JSON))
    if (Error) {
      logger.error(`[TD-plugin]队伍伤害${Error}请求失败，可使用 #更新小助手配置 手动重试`)
    } else {
      logger.info(logger.magenta('[TD-plugin]>>已写入CHAR_DATA、HASH_TRANS、CALC_RULES、RELIC_APPEND配置项'))
    }
  } catch (err) {
    logger.error('[TD-plugin]写入配置项失败，请检查错误信息！')
    console.log(err)
  }
}

async function LocalUpdateJson (URL) {
  try {
    const res = await axios.get(URL)
    return res.data
  } catch (error) {
    logger.info(logger.red(`${URL}请求失败...`))
    console.error(error)
    return null
  }
}
