/** Original fixed content for family B. Query and request refs come from the request. */
export function familyBSearch({query, requestRef, scenario}) {
  const batch = (suffix) => `${requestRef}:${suffix}`;
  const mainItems = [
    '露营装备清单：按睡眠、饮水和照明分组准备。',
    '营地准备记录：出发前检查天气和营地规则。',
    '城市散步路线：沿河岸步道经过旧街区。',
  ];
  const asideItems = ['露营装备推荐：睡袋、饮水、照明和天气防护。'];
  if (scenario === 'empty') return {status: 'empty', query, requestRef, batchRef: batch('empty'), items: [], aside: []};
  if (scenario === 'error') return {status: 'error', query, requestRef, message: '请求失败，输入已保留'};
  if (scenario === 'blocked') return {status: 'blocked', access: 'login_required', query, requestRef};
  if (scenario === 'blocked-empty') return {status: 'blocked', access: 'login_required', query, requestRef, empty: true};
  if (scenario === 'aside-match') {
    return {status: 'ok', query, requestRef, batchRef: batch('batch-1'),
      items: ['城市散步路线：沿河岸步道经过旧街区。', '河岸公园观察：记录树荫和休息点。'],
      aside: asideItems};
  }
  if (scenario === 'two-matches') {
    return {status: 'ok', query, requestRef, batchRef: batch('batch-1'),
      items: ['露营装备清单：按睡眠和饮水分组准备。', '营地准备记录：出发前整理装备。'],
      aside: asideItems};
  }
  return {status: 'ok', query, requestRef, batchRef: batch('batch-1'), items: mainItems, aside: asideItems};
}
