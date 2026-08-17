import fetch from 'node-fetch'
import _ from 'lodash'
import { Format } from '../../miao-plugin/components/index.js'
import { Character, Player, Artifact } from '../../miao-plugin/models/index.js'
import getServer from './getServer.js'
import simpleTeamDamageRes from './simpleTeamDamageRes.js'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ReturnTeamArr } from '../config/ReturnSimpleArr/getTeamString.js'

let cwd = process.cwd().replace(/\\/g, '/')
/** 🔥 1:1 对齐 FanSky 原版 getTeyvatData.js 的 headers（它不带 charset，也不带 accept-encoding）——
 *  之前我们加了过多的 UA 字段、charset、accept-encoding，以及顶层 from/timestamp/gameid 等脏字段，
 *  服务器可能会按「来源校验失败」直接返回默认 0 伤害结构。所以这次按原版极简，一个不多一个不少 */
const headers = {
  referer: 'https://servicewechat.com/wx2ac9dce11213c3a8/192/page-frame.html',
  'user-agent':
    'Mozilla/5.0 (Linux; Android 12; SM-G977N Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/86.0.4240.99 XWEB/4375 MMWEBSDK/20221011 Mobile Safari/537.36 MMWEBID/4357 MicroMessenger/8.0.30.2244(0x28001E44) WeChat/arm64 Weixin GPVersion/1 NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android'
}
let attrsKeys =
  {
    'def': '防御力',
    'defPlus': '防御力',
    'hpPlus': '生命值',
    'hp': '生命值',
    'atkPlus': '攻击力',
    'atk': '攻击力',
    'recharge': '元素充能效率',
    'mastery': '元素精通',
    'cpct': '暴击率',
    'cdmg': '暴击伤害',
    'heal': '治疗加成',
    'pyro': '火',
    'hydro': '水',
    'cryo': '冰',
    'electro': '雷',
    'anemo': '风',
    'geo': '岩',
    'phy': '物理',
    'dendro': '草'
  }
// 标准英文元素伤害字段（小助手里/接口文档里常用这套）：pyro_dmg/hydro_dmg/cryo_dmg/electro_dmg/anemo_dmg/geo_dmg/dendro_dmg/physical_dmg
// 同时保留旧的中文直译 fire/water/ice/thunder/wind/rock/grass 两套以防万一
let dmgKeys = [
  { std: 'pyro_dmg',     alt: 'fire_dmg',     elem: 'pyro' },
  { std: 'hydro_dmg',    alt: 'water_dmg',    elem: 'hydro' },
  { std: 'cryo_dmg',     alt: 'ice_dmg',      elem: 'cryo' },
  { std: 'electro_dmg',  alt: 'thunder_dmg',  elem: 'electro' },
  { std: 'anemo_dmg',    alt: 'wind_dmg',     elem: 'anemo' },
  { std: 'geo_dmg',      alt: 'rock_dmg',     elem: 'geo' },
  { std: 'dendro_dmg',   alt: 'grass_dmg',    elem: 'dendro' }
]
/** 角色元素 → 小助手固定枚举 ID（和小程序抓包 1:1）：
 *  胡桃 element=219、钟离=23、夜兰=37、莫娜=124、冰系角色=115、雷=151、风=92、草=318、物理=1
 *  本枚举直接抄 _captcha_verify.mjs 里成功的那几份角色值 */
const elemIdMap = {
  pyro: 219,   火: 219,
  geo: 23,     岩: 23,
  hydro: 37,   水: 37,
  cryo: 115,   冰: 115,
  electro: 151,雷: 151,
  anemo: 92,   风: 92,
  dendro: 318, 草: 318
}
/** 英文元素 ↔ 中文名互查（profile.elem 是 miao-plugin 的英文 pyro/hydro...） */
const elemCnMap = { pyro: '火', hydro: '水', cryo: '冰', electro: '雷', anemo: '风', geo: '岩', dendro: '草' }

/**
 * 将 combo_intro 格式的字符串转换为 API 所需数组：[role_no, code, code, ...]
 * 输入: "芙宁娜E,Q,那维莱特E,枫原万叶长E,Q,那维莱特Q,重击,重击,重击"
 * 输出: [2, "e", "q", 1, "e", 4, "e", "q", 1, "q", "zj", "zj", "zj"]
 */
function buildComboArray (comboStr, teamar) {
  if (!comboStr || !Array.isArray(teamar) || teamar.length === 0) return []
  const actionToCode = {
    A: 'a', A1: 'a1', A2: 'a2', A3: 'a3', A4: 'a4', A5: 'a5',
    重击: 'zj', ZJ: 'zj',
    Q: 'q', E: 'e', 长E: 'e',
    跳跃: 'k', 跳: 'k',
    闪避: 's', 闪: 's',
    冲刺: 'dash', 下落攻击: 'fall'
  }
  // 建立角色名 → role_no（1-based）映射
  const nameToNo = new Map()
  teamar.forEach((v, i) => {
    const n = v?.name
    if (n) nameToNo.set(n, i + 1)
  })
  const tokens = comboStr.split(',').filter(Boolean)
  const arr = []
  let currentRoleNo = -1
  for (const tok of tokens) {
    // 检查 token 是否以某个角色名开头
    let matched = false
    for (const [name, roleNo] of nameToNo) {
      if (tok.startsWith(name)) {
        // 角色切换时推入编号
        if (roleNo !== currentRoleNo) {
          arr.push(roleNo)
          currentRoleNo = roleNo
        }
        const actionTok = tok.slice(name.length)
        if (actionTok) {
          const code = actionToCode[actionTok] || actionTok.toLowerCase()
          arr.push(code)
        }
        matched = true
        break
      }
    }
    if (!matched) {
      // 纯动作（同角色后续）
      const code = actionToCode[tok] || tok.toLowerCase()
      arr.push(code)
    }
  }
  return arr
}

export async function team (e, teamlist, uid, detail, customComboStr, roleActionsArr) {
  if (teamlist.length === 1) {
    const res = await ReturnTeamArr(teamlist[0])
    if (res && res[0]) {
      teamlist = res
    } else if (res.err) {
      await e.reply(res.err)
      return
    } else {
      await e.reply(`暂未发现[${teamlist[0]}]简写\n尝试识别为单人~`, true)
    }
  } else if (teamlist.length === 0) {
    await e.reply('请指定您要计算的队伍喵~', true)
    return true
  } else if (teamlist.length > 4) {
    teamlist = teamlist.slice(0, 4)
  }

  let teamarId = []
  let errMsg = ''
  try {
    _.each(teamlist, v => {
      let char_p_l = Character.get(v.split('(')[0].trim())
      let char_p_t = _.clone(char_p_l)
      if (!char_p_t) {
        errMsg = `队伍中存在未能识别的角色：${v.split('(')[0].trim()}`
        throw new Error()
      }
      teamarId.push(char_p_t)
    })
  } catch (error) {
    await e.reply(errMsg)
    return
  }

  const server = getServer(uid, true)
  const serMap = { cn_gf01: '天空岛', cn_qd01: '世界树', os_usa: '美服', os_euro: '欧服', os_asia: '亚服', os_cht: '台港澳服' }
  const serverCn = serMap[server] || server || '天空岛'
  const uidStr = String(uid || '')
  // 1:1 对齐 FanSky 原版 transToTeyvatRequest L12-15 顶层结构：
  //   原版只有 { uid, role_data }；当 UID 第1位不是 '1' 且不是 '2' 时，才额外加 server（中文名）
  //   传了自定义手法时：
  //     custom_combo = 纯动作时序字符串（剥掉所有角色名前缀）
  //     custom = 接口返回标准结构 JSONArray（4 角色 skill[]，每个 skill 带 combo_num/repeat）
  //     has_custom_change = true（显式告诉接口：这是自定义手法）
  let TiwateBody = { uid: uidStr, role_data: [] }
  if (uidStr && uidStr[0] !== '1' && uidStr[0] !== '2') {
    TiwateBody.server = serverCn
  }
  const _comboClean = String(customComboStr || '').replace(/[\s,，、]+/g, ',').replace(/,+/g, ',').replace(/^,+|,+$/g, '')
  const hasCustomCombo = !!_comboClean
  let rolesData = {}
  let weaponsData = {}
  let NoDataName = []
  let isData = []
  let player = Player.create(uid)
  let role_data = []

  try {
    for (const v of teamarId) {
      let char = v.name
      let profile = player.getProfile(v.id)
      if (['旅行者', '空', '荧', '萤'].includes(char)) {
        errMsg = '[旅行者]暂不支持计算伤害喵！~'
        throw new Error()
      }
      if (!profile || !profile.hasData) {
        NoDataName.push(char)
        continue
      }
      isData.push(char)
      let m_roleData = await covProfileroleData(profile)
      rolesData[char] = m_roleData
      weaponsData[char] = m_roleData.weapon
      let m_TeyvatData = await covProfileTeyvatData(profile, { uidStr, serverCn })
      role_data.push(m_TeyvatData)
    }
  } catch (error) {
    if (errMsg) {
      await e.reply(errMsg)
    } else {
      logger.error(`[TD-plugin]构造请求体异常：${error?.message || error}`)
      await e.reply(`构造队伍伤害请求出错：${error?.message || error}`, true)
    }
    return
  }
  if (NoDataName.length > 0) {
    await e.reply(`UID${uid}：缺少${NoDataName.join('|')}\n请先通过【#更新面板】拿到对应角色数据。`, true)
    return true
  }

  await e.reply(`UID${uid}：${isData.join('|')}`)
  logger.info(logger.cyan(`[TD-plugin]队伍伤害[请求UID:${uid}]>>>${isData.join('|')}`))
  TiwateBody.role_data = role_data
  // 🔥 自定义手法：从小程序抓包确认 custom_combo 是数组格式 [role_no, code, code, ...]
  //    例如 custom_combo=[1, "a1", "zj"] 对应 combo_intro="胡桃A1,重击"
  if (hasCustomCombo && teamarId.length > 0) {
    const comboArr = buildComboArray(_comboClean, teamarId)
    if (comboArr.length > 0) {
      TiwateBody.from = 'normal'
      TiwateBody.timestamp = Date.now()
      TiwateBody.custom_combo = comboArr
      logger.warn(`[TD-plugin]🔥 发送 custom_combo 数组：[${comboArr.join(',')}]`)
    }
  }
  const bodyStr = JSON.stringify(TiwateBody)
  const TiwateRaw = await getTeyvatData(TiwateBody, 'team')
  if (TiwateRaw.code !== 200 || !TiwateRaw.result) {
    const msg = TiwateRaw.tips || TiwateRaw.result || TiwateRaw.info || '未知错误'
    logger.error(`>>>[提瓦特小助手错误] code=${TiwateRaw.code} msg=${msg}`)
    await e.reply(`提瓦特小助手接口错误：${msg}`, true)
    return true
  } else {
    const result = TiwateRaw.result
    const hasTeamFields = !!(result.role_list && result.chart_data && result.combo_intro)
    const errMsg = result.zdl_tips1 || result.zdl_tips0 || ''
    if (!hasTeamFields || /暂不支持|失败|错误/.test(errMsg)) {
      const reply = errMsg || '小助手未返回队伍伤害结果（可能该队伍组合不被支持）'
      logger.warn(`[TD-plugin]队伍伤害未生成：${reply}`)
      await e.reply(`[TD-plugin]${reply}`, true)
      return true
    }
    let data = await simpleTeamDamageRes(result, rolesData)
    if (data.error) {
      await e.reply(`[TD-plugin]解析伤害结果失败：${data.error}`, true)
      return true
    }
    for (const key in weaponsData) {
      if (!data.avatars || !data.avatars[key]) continue
      data.avatars[key].weapon.imgPath = weaponsData[key].weaponPath
    }
    let ScreenData = await screenData(e, data, detail)
    let img = await puppeteer.screenshot('TD-plugin', ScreenData)
    await e.reply(img)
    return true
  }
}

async function screenData (e, data, detail) {
  const RoleData = await JSON.parse(data['pie_data'])
  const DamageMap = await RoleData.map((item) => item.damage)
  const total = await DamageMap.reduce((prev, cur) => prev + cur)
  const percent = await DamageMap.map((item) => (item / total).toFixed(2))
  const RoleColor = await JSON.parse(data['pie_color'])
  const NameChar = await RoleData.map((item) => item.char)
  const Result = { percent, RoleColor, NameChar }
  const Result2 = RoleData.reduce((acc, d, i) => {
    acc[d.char] = {
      name: d.char,
      damage: d.damage,
      color: RoleColor[i]
    }
    return acc
  }, {})
  return {
    version: 'TD-plugin',
    YunzaiName: 'TD-plugin',
    YunzaiVersion: 'TD-plugin',
    result: Result2,
    RoleData: RoleData,
    quality: 100,
    AcgBg: '',
    Bing: Result,
    detail: detail,
    data: data,
    cwd: cwd,
    saveId: e.user_id,
    miaoRes: `${cwd}/plugins/miao-plugin/resources/`,
    tplFile: `${cwd}/plugins/TD-plugin/resources/Teyvat/html.html`,
    /** 绝对路径 */
    pluResPath: `${cwd}/plugins/TD-plugin/resources/Teyvat/`
  }
}

/** FanSky 原版 kStr（完全本地化，reverse=true 请求体专用长中文）
 *  【0W 致命修复】：miao-plugin 返回的主词条/副词条 key 常带 Plus 结尾（hpPlus/atkPlus/defPlus），
 *  之前 enMap 只配 hp/atk/def → 这些字段一直没翻译，服务器读不懂→词条 0→总伤 0W */
function kStr (prop, reverse = false) {
  if (!prop) return ''
  if (reverse) {
    const enMap = {
      hp: '生命值', hpp: '生命值', hpPlus: '生命值', hp_plus: '生命值',
      atk: '攻击力', atkp: '攻击力', atkPlus: '攻击力', atk_plus: '攻击力',
      def: '防御力', defp: '防御力', defPlus: '防御力', def_plus: '防御力',
      cpct: '暴击率', crit: '暴击率', critRate: '暴击率',
      cdmg: '暴击伤害', critDmg: '暴击伤害',
      mastery: '元素精通', em: '元素精通',
      recharge: '元素充能效率',
      heal: '治疗加成',
      phy: '物理伤害加成', physical: '物理伤害加成',
      pyro: '火元素伤害加成', fire_dmg: '火元素伤害加成',
      hydro: '水元素伤害加成', water_dmg: '水元素伤害加成',
      electro: '雷元素伤害加成', thunder_dmg: '雷元素伤害加成',
      anemo: '风元素伤害加成', wind_dmg: '风元素伤害加成',
      cryo: '冰元素伤害加成', ice_dmg: '冰元素伤害加成',
      geo: '岩元素伤害加成', rock_dmg: '岩元素伤害加成',
      dendro: '草元素伤害加成', grass_dmg: '草元素伤害加成'
    }
    if (enMap[prop]) return enMap[prop]
    let s = String(prop)
    return s.replace('充能', '元素充能').replace('伤加成', '元素伤害加成').replace('物理元素', '物理')
  }
  let s = String(prop)
  return s.replace('百分比', '').replace('元素充能', '充能').replace('元素伤害', '伤').replace('物理伤害', '物伤')
}

/** 🔥 1:1 按 FanSky 原版 TransToTeyvatRequest.js L73-L105 逐行抄——
 *   子角色字段一个不多一个不少；数值类型/字符串格式严格对齐 */
async function covProfileTeyvatData (profile, ctx) {
  const uidStr = (ctx && typeof ctx === 'object' ? ctx.uidStr : String(ctx || '')) || ''
  const a = profile.attr || {}
  const base = profile.base || {}

  // Step 1：构造 fightProp/baseProp（中文键 + 数值规范）
  // 【🔴 0W 致命修复】：miao-plugin attr 的 cpct/cdmg/recharge/heal/phy/pyro/hydro/...
  //   返回的本身已经是「64.1 / 257.1 / 117.5 / 61.6」这种 0-100 的百分比数值，不是 0.64！
  //   之前多乘了 *100 → 请求体变成 crit:"6407%" → 服务器判非法数据→总伤 0W
  const fightProp = {
    生命值: Number(a.hp) || 0,
    攻击力: Number(a.atk) || 0,
    防御力: Number(a.def) || 0,
    暴击率: Number(a.cpct) || 0,
    暴击伤害: Number(a.cdmg) || 0,
    治疗加成: Number(a.heal) || 0,
    元素精通: Number(a.mastery) || 0,
    元素充能效率: Number(a.recharge) || 0,
    物理伤害加成: Number(a.phy) || 0,
    火元素伤害加成: Number(a.pyro) || 0,
    水元素伤害加成: Number(a.hydro) || 0,
    雷元素伤害加成: Number(a.electro) || 0,
    风元素伤害加成: Number(a.anemo) || 0,
    冰元素伤害加成: Number(a.cryo) || 0,
    岩元素伤害加成: Number(a.geo) || 0,
    草元素伤害加成: Number(a.dendro) || 0
  }
  const baseProp = {
    生命值: Number(base.hp) || 0,
    攻击力: Number(base.atk) || 0,
    防御力: Number(base.def) || 0
  }

  // Step 2：FanSky 原版 L25-L51 的角色/武器特殊修正（1:1，数值绝对一致）
  const name = profile.char?.name || ''
  const cons = Number(profile.cons) || 0
  const weapon = profile.weapon || {}
  const weaponName = weapon.name || ''
  const weaponAffix = Number(weapon.affix) || 1
  const weaponLevel = Number(weapon.level) || 1
  if (name === '雷电将军') {
    const _thunderDmg = fightProp['雷元素伤害加成']
    const _recharge = fightProp['元素充能效率']
    fightProp['雷元素伤害加成'] = Math.max(0, _thunderDmg - (_recharge - 100) * 0.4)
  }
  if (name === '莫娜') {
    const _waterDmg = fightProp['水元素伤害加成']
    const _recharge = fightProp['元素充能效率']
    fightProp['水元素伤害加成'] = Math.max(0, _waterDmg - _recharge * 0.2)
  }
  if (name === '妮露' && cons === 6) {
    const _count = parseFloat(fightProp['生命值'] / 1000)
    const _crit = fightProp['暴击率']
    const _critDmg = fightProp['暴击伤害']
    fightProp['暴击率'] = Math.max(5, _crit - Math.min(30, _count * 0.6))
    fightProp['暴击伤害'] = Math.max(50, _critDmg - Math.min(60, _count * 1.2))
  }
  if (['息灾', '波乱月白经津', '雾切之回光', '猎人之径'].includes(weaponName)) {
    for (const elem of ['火', '水', '雷', '风', '冰', '岩', '草']) {
      const _origin = fightProp[`${elem}元素伤害加成`] || 0
      fightProp[`${elem}元素伤害加成`] = Math.max(0, _origin - 12 - 12 * (weaponAffix - 1) / 4)
    }
  }

  // Step 3：skills（talent 字段，FanSky 原版直接 skills.a.level/e.level/q.level）
  const talent = profile.talent || {}
  const skills = {
    a: { level: (talent.a && talent.a.level) || 1 },
    e: { level: (talent.e && talent.e.level) || 1 },
    q: { level: (talent.q && talent.q.level) || 1 }
  }

  // Step 4：artifacts（圣遗物套装字符串，原版 L100 1:1）
  const artisDetail = profile.getArtisMark?.() || null
  const relicSet = (artisDetail && artisDetail.sets) ? artisDetail.sets : {}
  const artifactJoin = Object.entries(relicSet)
    .filter(([k, v]) => v >= 2 || String(k).includes('之人'))
    .map(([k, v]) => `${k}${v >= 4 ? 4 : v >= 2 ? 2 : 1}`)
    .join('+')

  // Step 5：artifacts_detail（5 件圣遗物，FanSky L52-L71 1:1）
  //  - FanSky 原版 relics[i] 结构：{name, pos:1~5, level, main:{prop,value}, sub:[{prop,value}, ...]}
  //  - 我们用 miao-plugin profile 的 artis/artisDetail 拼出同样的结构
  const artiTypes = ['生之花', '死之羽', '时之沙', '空之杯', '理之冠']
  const relics = []
  // 【🔴 0W 致命修复 3/4】：主词条 mainvalue 清洗：
  //   字符串先去掉逗号/中文逗号/空白 → 若不含%结尾 → 尝试转 number（接口 number 会 parseInt 用）
  //   否则保持 string（带%的直接发，不要转 number）
  //   之前 mainvalue="4,778.6" 带逗号被接口 parseInt("4,778.6")→只读到 4，生命花主词条 4HP vs 4778HP→差了 3 个数量级直接崩
  const cleanComma = (s) => String(s == null ? '' : s).replace(/[,，\s]/g, '')
  const normMainVal = (v) => {
    if (typeof v === 'number') return v
    if (v == null) return 0
    const s = cleanComma(v)
    if (s === '') return 0
    if (/%$/.test(s)) return s
    const n = Number(s)
    return Number.isFinite(n) ? n : s
  }
  // 副词条 value：同样去逗号空白（保留 string，FanSky L64 直接 + 拼接）
  const normSubVal = (v) => (v == null ? '' : cleanComma(v))

  for (let posIdx = 1; posIdx <= 5; posIdx++) {
    const rawArti = profile.artis?.artis?.[posIdx] || profile.artis?.artis?.[String(posIdx)] || {}
    const marked = (artisDetail?.artis?.[posIdx] || artisDetail?.artis?.[String(posIdx)]) || {}
    // 主词条 main{prop,value}：优先用 marked.main（已经格式化的 value，接口认得）
    let mainProp = (marked?.main && marked.main.key) || rawArti.main?.key || ''
    let mainValRaw = (marked?.main && marked.main.value != null) ? marked.main.value
              : (rawArti?.main && rawArti.main.value != null) ? rawArti.main.value
              : 0
    const mainVal = normMainVal(mainValRaw)
    // 副词条 sub：[{prop,value}]，value 字符串（带%或纯数字字符串，FanSky L64 直接 + 拼接）
    const sub = []
    if (rawArti?.attrs) {
      for (const [, rawAttr] of Object.entries(rawArti.attrs)) {
        if (!rawAttr) continue
        let value = null
        let prop = rawAttr.key || ''
        // 先按长中文键查 marked.attrs（miao-plugin getArtisMark 返回的 attrs 就是按长中文做 key）
        const cnLong = prop ? kStr(prop, true) : ''
        if (cnLong && marked?.attrs && marked.attrs[cnLong] && marked.attrs[cnLong].value != null) {
          value = normSubVal(marked.attrs[cnLong].value)
        } else if (rawAttr.value != null) {
          value = normSubVal(rawAttr.value)
        }
        if (value == null || value === '') continue
        sub.push({ prop, value })
      }
    }
    relics.push({
      name: rawArti.name || '',
      pos: posIdx,
      level: Math.max(0, parseInt(rawArti.level) || 0),
      main: { prop: mainProp, value: mainVal },
      sub
    })
  }
  // 现在按 FanSky L52-L71 把 relics 变成 artifacts_detail（我们完全用 FanSky 同一段逻辑逐字抄）
  let artifacts_detail = []
  for (let rc of relics) {
    let tData = {
      artifacts_name: rc.name,
      artifacts_type: artiTypes[rc.pos - 1],
      level: rc.level,
      maintips: kStr(rc.main.prop, true),
      mainvalue: (typeof rc.main.value === 'number') ? parseInt(rc.main.value) : rc.main.value
    }
    let tips = {}
    for (let sIdx = 0; sIdx < 4; sIdx++) {
      if (sIdx < rc.sub.length) {
        tips['tips' + (sIdx + 1)] = kStr(rc.sub[sIdx].prop, true) + '+' + rc.sub[sIdx].value
      } else {
        tips['tips' + (sIdx + 1)] = ''
      }
    }
    tData = { ...tData, ...tips }
    artifacts_detail.push(tData)
  }

  // Step 6：🔥🔥 最终子角色对象 —— 1:1 FanSky 原版 L73-L105（关键！一个字段不多，一个字段不少）
  const avatarLevel = parseInt(profile.level) || 1
  return {
    // 原版 L74：uid 必须有，是字符串
    uid: uidStr,
    role: name,
    role_class: cons,
    level: avatarLevel,
    weapon: weaponName,
    weapon_level: weaponLevel,
    weapon_class: `精炼${weaponAffix}阶`,
    hp: parseInt(fightProp['生命值']),
    base_hp: parseInt(baseProp['生命值']),
    attack: parseInt(fightProp['攻击力']),
    base_attack: parseInt(baseProp['攻击力']),
    defend: parseInt(fightProp['防御力']),
    base_defend: parseInt(baseProp['防御力']),
    // 🔥 原版 L87 写死：element = Math.round(fightProp['元素精通']) —— 不是元素枚举 ID！
    element: Math.round(fightProp['元素精通']),
    // 所有百分比：严格按原版 `${_.round(fightProp['XXX'], 1)}%`
    crit: `${_.round(fightProp['暴击率'], 1)}%`,
    crit_dmg: `${_.round(fightProp['暴击伤害'], 1)}%`,
    heal: `${_.round(fightProp['治疗加成'], 1)}%`,
    recharge: `${_.round(fightProp['元素充能效率'], 1)}%`,
    fire_dmg: `${_.round(fightProp['火元素伤害加成'], 1)}%`,
    water_dmg: `${_.round(fightProp['水元素伤害加成'], 1)}%`,
    thunder_dmg: `${_.round(fightProp['雷元素伤害加成'], 1)}%`,
    wind_dmg: `${_.round(fightProp['风元素伤害加成'], 1)}%`,
    ice_dmg: `${_.round(fightProp['冰元素伤害加成'], 1)}%`,
    rock_dmg: `${_.round(fightProp['岩元素伤害加成'], 1)}%`,
    grass_dmg: `${_.round(fightProp['草元素伤害加成'], 1)}%`,
    physical_dmg: `${_.round(fightProp['物理伤害加成'], 1)}%`,
    // 圣遗物套装字符串（原版 L100）
    artifacts: artifactJoin,
    // 天赋（原版 L101-L103）
    ability1: skills.a.level,
    ability2: skills.e.level,
    ability3: skills.q.level,
    // 5 件圣遗物详情（原版 L52-L71 拼出来的）
    artifacts_detail
  }
}

async function covProfileroleData (profile) {
  let roleData = {}
  roleData['id'] = profile.char.id
  roleData['name'] = profile.char.name
  // 角色头像（用于渲染面板头像展示）
  try {
    let charImgs = profile.char.getImgs()
    roleData['icon'] = charImgs.qFace || charImgs.face || ''
  } catch (err) {
    roleData['icon'] = ''
  }
  roleData['element'] = attrsKeys[profile.elem]
  roleData['fetter'] = profile.char.fetter
  roleData['cons'] = profile.cons
  roleData['level'] = profile.level
  let weapon = {}
  weapon['name'] = profile.weapon.name
  weapon['rarity'] = profile.weapon.star
  weapon['affix'] = profile.weapon.affix
  weapon['level'] = profile.weapon.level
  weapon['icon'] = profile.weapon.img
  weapon['weaponPath'] = profile.weapon.type + '/' + profile.weapon.name

  roleData['weapon'] = weapon
  let fightProp = {}
  fightProp['暴击率'] = profile.attr.cpct
  fightProp['暴击伤害'] = profile.attr.cdmg
  fightProp['生命值'] = profile.attr.hp
  fightProp['攻击力'] = profile.attr.atk
  fightProp['防御力'] = profile.attr.def
  fightProp['元素精通'] = profile.attr.mastery
  fightProp['治疗加成'] = profile.attr.heal
  fightProp['元素充能效率'] = profile.attr.recharge
  roleData['fightProp'] = fightProp

  let skill_a = {}
  skill_a['style'] = ''
  skill_a['icon'] = 'Skill_A_' + profile.char.name
  skill_a['level'] = profile.talent.a.level
  skill_a['originLvl'] = profile.talent.a.original
  if (profile.talent.a.level > profile.talent.a.original) {
    skill_a['style'] = 'extra'
  }

  let skill_e = {}
  skill_e['style'] = ''
  skill_e['icon'] = 'Skill_S_' + profile.char.name
  skill_e['level'] = profile.talent.e.level
  skill_e['originLvl'] = profile.talent.e.original
  if (profile.talent.e.level > profile.talent.e.original) {
    skill_e['style'] = 'extra'
  }

  let skill_q = {}
  skill_q['style'] = ''
  skill_q['icon'] = 'Skill_E_' + profile.char.name
  skill_q['level'] = profile.talent.q.level
  skill_q['originLvl'] = profile.talent.q.original
  if (profile.talent.q.level > profile.talent.q.original) {
    skill_q['style'] = 'extra'
  }

  let skills = {}
  skills['a'] = skill_a
  skills['e'] = skill_e
  skills['q'] = skill_q
  roleData['skills'] = skills
  let artisDetail = profile.getArtisMark()
  roleData['relicSet'] = artisDetail.sets
  // 补齐每个圣遗物的 setName / icon，供 simpleTeamDamageRes 取套装
  roleData['relics'] = []
  try {
    profile.artis.forEach((arti, idx) => {
      let artiObj = null
      try {
        artiObj = arti?.name ? Artifact.get(arti) : null
      } catch (e) { /* Artifact 元数据缺失时忽略 */ }
      let setName = arti?.set || arti?.setName || ''
      let icon = artiObj?.img || ''
      roleData['relics'].push({ setName, icon })
    })
  } catch (err) {
    // 容错：无圣遗物时忽略
    logger.warn(`[TD-plugin][${profile.char.name}] 获取圣遗物列表失败：${err.message}`)
  }
  return roleData
}

/**
 * 获取小助手对应功能的数据
 * @param {String} TBody 请求需要的数据
 * @param {String} type 功能对应api 默认为 Single
 * @returns 小助手返回数据
 */
async function getTeyvatData (TBody, type = 'single') {
  const apiMap = {
    single: 'https://api.lelaer.com/ys/getDamageResult.php',
    team: 'https://api.lelaer.com/ys/getTeamResult.php'
  }
  const TIMEOUT_MS = 20000
  let controller
  let timeoutId
  try {
    controller = new AbortController()
    timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const response = await fetch(apiMap[type], {
      method: 'POST',
      headers: {
        // FanSky 原版 getTeyvatData.js 就是 'application/json'，不带 '; charset=utf-8'
        'Content-Type': 'application/json',
        ...headers
      },
      body: JSON.stringify(TBody),
      signal: controller.signal
    })
    clearTimeout(timeoutId)
    const rawText = await response.text()
    let jsonResponse
    try {
      jsonResponse = JSON.parse(rawText)
    } catch (parseErr) {
      logger.error(`[TD-plugin]接口返回非JSON：status=${response.status} body=${rawText.slice(0, 300)}`)
      return {
        code: -1,
        info: `接口返回非JSON（status ${response.status}）`
      }
    }
    if (jsonResponse.code !== 200 || !jsonResponse.result) {
      const msg = jsonResponse.tips || jsonResponse.result || jsonResponse.info || '未知错误'
      logger.warn(`[TD-plugin]接口异常：code=${jsonResponse.code} msg=${msg}`)
      logger.debug(`[TD-plugin]响应体：${JSON.stringify(jsonResponse).slice(0, 500)}`)
    }
    return jsonResponse
  } catch (error) {
    clearTimeout(timeoutId)
    if (error.name === 'AbortError') {
      logger.error(`[TD-plugin]接口超时（${TIMEOUT_MS}ms）：${apiMap[type]}`)
      return {
        code: -2,
        info: `提瓦特小助手接口请求超时（${TIMEOUT_MS / 1000}s）`
      }
    }
    logger.error(`[TD-plugin]接口请求异常：${error?.message || error}`)
    return {
      code: -3,
      info: `提瓦特小助手接口无法访问：${error?.message || error}`
    }
  }
}
