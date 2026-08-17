import axios from 'axios'

export async function getUrlJson (URL, e) {
  try {
    const res = await axios.get(`https://cdn.monsterx.cn/bot/gspanel/${URL}`)
    const json = res.data
    return json
  } catch (error) {
    console.log(error)
    console.log(`${URL}请求失败...`)
    return await e.reply(`${URL}\n请求失败~~`)
  }
}
