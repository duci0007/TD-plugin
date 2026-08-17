import fs from 'fs'
import { CheckConfig } from './tools/CheckConfig.js'

let Cwd = process.cwd().replace(/\\/g, '/')
let Version
logger.info(logger.magenta(`'-------------TD-plugin-------------`))
try {
  Version = await JSON.parse(fs.readFileSync(`${Cwd}/plugins/TD-plugin/package.json`, 'utf-8'))
} catch (err) {
  Version = { version: '1.0.0' }
}
logger.info(logger.magenta(`----TD-plugin【${Version.version}】初始化中------`))
const files = fs.readdirSync('./plugins/TD-plugin/apps').filter(file => file.endsWith('.js'))
await CheckConfig()
let ret = []
files.forEach((file) => {
  ret.push(import(`./apps/${file}`))
})
ret = await Promise.allSettled(ret)
let apps = {}
let APackageError = 0
for (let i in files) {
  let name = files[i].replace('.js', '')
  if (ret[i].status !== 'fulfilled') {
    logger.error(`[TD-plugin]载入JS错误：${logger.red(name)}`)
    const ARegex = /Cannot find package '([^']+)'/;
    let AReason = ret[i].reason + ''
    const AMatch = AReason.match(ARegex);
    if (AMatch) {
      const APackageName = AMatch[1];
      logger.warn(`请先在${logger.red(`plugins/TD-plugin`)}目录运行：${logger.red(`pnpm install`)}安装依赖`)
      logger.error(AReason)
      APackageError++
    } else {
      logger.error(ret[i].reason)
    }
    delete apps[name];
    continue
  }
  apps[name] = ret[i].value[Object.keys(ret[i].value)[0]]
}
logger.info(logger.magenta(`----TD-plugin载入完成------`))
if (APackageError > 0) {
  logger.warn(logger.yellow(`---请按提示安装依赖，否则对应功能会无效喵！------`))
}
export { apps }
