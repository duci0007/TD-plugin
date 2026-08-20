/* eslint-disable camelcase */
import _ from 'lodash'
import fs from 'node:fs'
import { Character } from '../../miao-plugin/models/index.js'

const cwd = process.cwd().replace(/\\/g, '/')
const miaoRes = `${cwd}/plugins/miao-plugin/resources`

/**
 * 转换队伍伤害计算请求数据为精简格式
 * @param {Object} raw 队伍伤害计算请求数据，由 getTeyvatData(*, "team")["result"] 获取
 * @param {Object} rolesData 角色数据，键为角色中文名，值为内部格式
 * @returns {Object} 精简格式伤害数据。出错时返回 {"error": "错误信息"}
 */
async function simpleTeamDamageRes (raw, rolesData) {
  if (!raw || typeof raw !== 'object') {
    return { error: '接口返回为空或非对象' }
  }
  // 关键字段全部缺失时一次打印顶层 key，便于定位字段名差异
  const needKeys = ['zdl_tips0', 'chart_data', 'role_list', 'recharge_info', 'advice', 'combo_intro', 'buff']
  const missing = needKeys.filter(k => !(k in raw))
  if (missing.length) {
    logger.warn(`[TD-plugin]接口返回缺少字段：${missing.join(',')}；实际顶层字段：${Object.keys(raw).join(',')}`)
  }

  /** 解析带 W/万/亿 单位的伤害字符串为纯数值，容错空格、逗号 */
  const parseDmg = (s) => {
    if (s === null || s === undefined) return 0
    let str = String(s).replace(/[,，\s]/g, '')
    if (!str) return 0
    const m = str.match(/^(-?\d+(?:\.\d+)?)(W|万|w|亿|千|K|k|M|m)?$/)
    if (!m) {
      // 剩余部分尝试纯数字（例如 "218.7"、"123456"）
      const n = parseFloat(str)
      return Number.isFinite(n) ? n : 0
    }
    const num = parseFloat(m[1])
    const unit = m[2] || ''
    let mul = 1
    switch (unit) {
      case 'W': case 'w': case '万': mul = 10000; break
      case '亿': mul = 100000000; break
      case '千': case 'K': case 'k': mul = 1000; break
      case 'M': case 'm': mul = 1000000; break
      default: mul = 1
    }
    return Number.isFinite(num * mul) ? (num * mul) : 0
  }
  /** 把大数字格式化为 "218.7W" / "2.4W"，用于模板的 total 显示 */
  const fmtDmg = (n) => {
    const v = Number(n) || 0
    if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, '') + '亿'
    if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, '') + 'W'
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
    return String(Math.round(v))
  }

  // zdl_tips0 形如 "你的队伍18秒内造成总伤害218.7W，DPS为:"
  // 同时兼容旧格式 "你的队伍3秒内造成总伤害12345，DPS为:4115"
  let tm = ''; let total = ''
  if (raw.zdl_tips0) {
    try {
      const tmM = String(raw.zdl_tips0).match(/(\d+(?:\.\d+)?)秒/)
      if (tmM) tm = tmM[1] + '秒'
      const totalM = String(raw.zdl_tips0).match(/总伤害\s*([0-9,.\sW万亿wKkmM]+)/)
      if (totalM) {
        const totalNum = parseDmg(totalM[1])
        total = fmtDmg(totalNum)
      }
    } catch (e) {
      logger.warn(`[TD-plugin]zdl_tips0 解析失败：${raw.zdl_tips0} | err=${e && e.message}`)
    }
  }
  // DPS 优先用接口专门返回的 zdl_result 数值（小程序也是这么用）
  let dpsRaw = raw.zdl_result
  if (dpsRaw === undefined || dpsRaw === null || dpsRaw === '') {
    // 旧接口兜底：从 zdl_tips0 里 "DPS为:4115" 取
    if (raw.zdl_tips0) {
      const dpsM = String(raw.zdl_tips0).match(/DPS\s*为[:：]\s*(-?\d+(?:\.\d+)?)/)
      if (dpsM) dpsRaw = Number(dpsM[1]) || 0
    }
  }
  const dps = Number.isFinite(Number(dpsRaw)) ? Math.round(Number(dpsRaw)) : (dpsRaw || 0)

  let pieData = []; let pieColor = []
  _.each(raw.chart_data || [], (v, idx) => {
    try {
      let name_split = (v.name || '').split('\n')
      const char = (name_split[0] || '').trim()
      let dmgStr = (name_split[1] || '').trim()
      // pieData.damage 单位固定为「万」（184 = 184万），和模板 formatter ${damage}W 对应
      let damageReal = parseDmg(dmgStr)
      if (!damageReal && typeof v.value === 'number') {
        const sum = (raw.chart_data || []).reduce((s, i) => s + (typeof i.value === 'number' ? i.value : 0), 0)
        const totalNum = parseDmg(total) || 1
        if (sum > 0) damageReal = Math.round((v.value / sum) * totalNum)
      }
      const damage = Math.round((damageReal / 10000) * 100) / 100
      if (!char) {
        logger.warn(`[TD-plugin]chart_data[${idx}] 缺少角色名，name=${JSON.stringify(v.name)}`)
        return
      }
      pieData.push({
        char,
        damage
      })
      pieColor.push(v.label?.color || '#888888')
    } catch (e) {
      logger.warn(`[TD-plugin]chart_data[${idx}] 解析失败：${e && e.message}；raw.name=${JSON.stringify(v && v.name)}`)
    }
  })
  // pieData 单位统一为真实数值，formatter 里再拼 W 后缀显示
  if (!pieData.length) logger.warn(`[TD-plugin]chart_data 解析后为空，原始条目数=${(raw.chart_data || []).length}`)
  pieData = _.sortBy(pieData, 'damage').reverse()
  // 寻找伤害最高的角色元素属性，跳过绽放等伤害来源
  let elem = _.map(_.filter(pieData, i => rolesData[i.char]), v => rolesData[v.char].element)[0]

  let avatars = {}
  _.each(raw.role_list || [], role => {
    let panelData = rolesData[role.role]
    if (!panelData) {
      logger.warn(`[TD-plugin]未找到 ${role.role} 的本地面板数据，跳过`)
      return
    }

    let relicSet = _.pickBy(panelData.relicSet || {}, i => i >= 2)
    let relics = _.map(_.filter(panelData.relics || [], r => _.keys(relicSet).includes(r.setName)), v => _.nth(v.icon.split('_'), -2))
    relics = _.countBy(relics, v => v)
    let sets = {}
    _.each(relics, (r, k) => {
      sets[k] = r < 4 ? 2 : 4
    })

    let skills = []
    _.each(panelData.skills || [], skill => {
      skills.push({
        icon: getTalentPath(role.role, skill.icon),
        style: skill.style,
        level: skill.level
      })
    })

    let weaponPath = getWeapon(panelData.weapon?.icon) || ''
    avatars[role.role] = {
      rarity: role.role_star,
      icon: panelData.icon,
      name: role.role,
      face: getFace(role.role),
      elem: panelData.element,
      cons: role.role_class,
      level: (role.role_level || '').replace('Lv', ''),
      weapon: {
        icon: panelData.weapon?.icon,
        level: panelData.weapon?.level,
        rarity: panelData.weapon?.rarity,
        affix: panelData.weapon?.affix,
        imgPath: weaponPath
      },
      relicSet,
      sets,
      cp: _.round(panelData.fightProp?.['暴击率'], 1),
      cd: _.round(panelData.fightProp?.['暴击伤害'], 1),
      key_prop: role.key_ability,
      key_value: role.key_value,
      skills
    }
  })

  _.each(raw.recharge_info || [], rechargeData => {
    try {
      let [name, tmp] = rechargeData.recharge.split('共获取同色球')
      let [same, diff] = tmp.split('个，异色球')
      if (diff.split('个，无色球').length === 2) {
        // 暂未排版无色球
        diff = diff.split('个，无色球')[0]
      }
      if (avatars[name]) {
        avatars[name].recharge = {
          pct: rechargeData.rate,
          same: _.round(parseFloat(same), 1),
          diff: _.round(parseFloat(diff.replace('个', '')), 1)
        }
      }
    } catch (e) {
      logger.warn(`[TD-plugin]recharge_info 解析失败：${rechargeData?.recharge}`)
    }
  })

  let damages = []
  let maxDamageStep = null
  let maxDamageVal = -Infinity
  for (let step of (raw.advice || [])) {
    if (!step.content) {
      logger.error(`奇怪的伤害：${step}`)
      continue
    }
    let [t, s] = step.content.split(' ')
    let a = s.split('，')[0]; let d = []
    if (s.split('，').length === 1) {
      d = ['-', '-', '-']
    } else {
      let dmgs = s.split('，')[1]
      if (dmgs.split(',').length === 1) {
        d = ['-', '-', _.last(dmgs.split(',')[0].split('：'))]
      } else {
        d = []
        _.each(dmgs.split(','), dd => {
          d.push(_.last(dd.split(':')))
        })
      }
    }
    damages.push([t.replace('s', ''), _.toUpper(a), ...d])
    // 最高伤害：d[0] 为暴击伤害，取全流程最大的一条
    const critVal = parseFloat(d[0])
    if (Number.isFinite(critVal) && critVal > maxDamageVal) {
      maxDamageVal = critVal
      maxDamageStep = step
    }
  }

  // 解析最高伤害归属角色：detail.0 形如 "当前钟离面板"，兜底用 content 动作串前缀匹配角色名
  let maxDamage = null
  if (maxDamageStep) {
    let char = ''
    try {
      const d0 = maxDamageStep.detail && (maxDamageStep.detail['0'] || maxDamageStep.detail[0])
      const cm = /当前(.+?)面板/.exec(String(d0 || ''))
      if (cm) char = cm[1]
    } catch (e) {}
    if (!char) {
      const s = String(maxDamageStep.content).split(' ')[1] || ''
      for (const r of (raw.role_list || [])) {
        if (r.role && s.startsWith(r.role)) { char = r.role; break }
      }
    }
    if (char && avatars[char] && avatars[char].face) {
      maxDamage = { char, value: Math.round(maxDamageVal), face: avatars[char].face }
    }
  }

  // buff 字段名可能是 buff / buffs / buff_intro，且不一定是数组
  let buffSrc = raw.buff || raw.buffs || raw.buff_intro
  let buffs = []
  if (Array.isArray(buffSrc)) {
    for (let buff of buffSrc) {
      if (!buff.content) {
        logger.error(`奇怪的buff：${buff}`)
        continue
      }
      let [t, tmp] = buff.content.split(' ')
      let b = tmp.split('-')[0]; let bd = _.tail(tmp.split('-')).join('-')
      buffs.push([t.replace('s', ''), _.toUpper(b), _.toUpper(bd)])
    }
  } else if (buffSrc && typeof buffSrc === 'object') {
    // 兼容 buff 为对象的情况：尝试遍历其值
    for (const k of Object.keys(buffSrc)) {
      const item = buffSrc[k]
      if (!item || !item.content) continue
      const [t, tmp] = item.content.split(' ')
      const b = tmp.split('-')[0]
      const bd = _.tail(tmp.split('-')).join('-')
      buffs.push([t.replace('s', ''), _.toUpper(b), _.toUpper(bd)])
    }
  } else if (buffSrc === undefined) {
    logger.warn(`[TD-plugin]接口返回未包含 buff 字段，顶层字段：${Object.keys(raw).join(',')}`)
  } else {
    logger.warn(`[TD-plugin]buff 字段类型异常：${typeof buffSrc}`)
  }

  // rank 优先用 zdl_tips2（如 "ACE"），兜底用 zdl_tips1 中"评级为XX"，都没有就给默认 B 保证面板显示
  let rank = raw.zdl_tips2
  if (!rank && raw.zdl_tips1) {
    const rM = String(raw.zdl_tips1).match(/评级为\s*([A-Za-z]+)/)
    if (rM) rank = rM[1]
  }
  if (!rank) rank = 'B'
  if (!tm) tm = '18秒'
  if (!total) total = '0'

  return {
    uid: raw.uid,
    elem,
    rank,
    dps,
    tm,
    total,
    pie_data: JSON.stringify(pieData),
    pie_color: JSON.stringify(pieColor),
    pie_data2: pieData,
    pie_color2: pieColor,
    avatars,
    actions: (raw.combo_intro || '').split(',').filter(Boolean),
    damages,
    buffs,
    maxDamage
  }
}

// 原 gsCfg 依赖在本环境不存在，且 weapon.imgPath 在 getTeam.js 中会被 miao-plugin 路径覆盖，故直接返回 false
function getWeapon (icon) {
  return false
}

function getTalentPath (role, icon) {
  let char = Character.get(role)
  if (!char) return '未知'
  let imgs = char.getImgs()
  let type = icon.split('_')[1]
  let path
  switch (type) {
    case 'A':
      path = imgs.a
      break
    case 'S':
      path = imgs.e
      break
    case 'E':
      path = imgs.q
      break
    default:
      return '未知'
  }
  return path ? path.replace(/^\//, '') : '未知'
}

function getFace (role) {
  let char = Character.get(role)
  if (!char) return ''
  let imgs = char.getImgs()
  let face = imgs.qFace || imgs.face || ''
  return face ? `${miaoRes}${face}` : ''
}

export default simpleTeamDamageRes
