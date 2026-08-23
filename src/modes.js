// “模式”现在只定义会议方法，不再把某个 Provider 永久绑定为提案者或审查者。
// 每次任务的成员、临时角色、主笔人和共识规则由 team 配置决定。
const MODES = {
  cocreation: {
    name: '开放共创',
    icon: '📝',
    instruction: '鼓励提出多种可行路径，比较取舍；区分已知事实、推断和待确认问题。'
  },
  review: {
    name: '严格评审',
    icon: '🔍',
    instruction: '重点寻找 bug、安全漏洞、边界条件、失败恢复、不可验证声明和测试缺口。'
  },
  adversarial: {
    name: '对抗推演',
    icon: '⚔️',
    instruction: '主动构造反例和攻击路径，再验证防御是否可绕过；不要提供可直接滥用的破坏性步骤。'
  },
  division: {
    name: '动态分工',
    icon: '🤝',
    instruction: '根据本次团队配置讨论职责、依赖、接口和合并验收，避免双方都以为对方会完成。'
  }
};

module.exports = { MODES };
