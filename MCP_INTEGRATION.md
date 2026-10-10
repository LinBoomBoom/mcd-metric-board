# MCP 接入说明

本文档说明本项目实际使用的麦当劳 MCP Server、调用流程与业务价值。

非麦当劳官方产品。所有数据由麦当劳 MCP 官方接口实时返回，项目不做任何数据加工或推测补全。

---

## 一、接入配置

| 项 | 值 |
|---|---|
| Server 地址 | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP |
| 认证方式 | 请求头 `Authorization: Bearer <MCP_TOKEN>` |
| 限流 | 每 Token 每分钟 600 次，超限返回 429 |
| 接入平台 | 支持 Streamable HTTP 的 MCP Client（WorkBuddy / Cursor / Cherry Studio / Trae 等） |

配置示例见仓库根目录 `mcp-config.example.json`，真实配置请通过环境变量注入。

---

## 二、实际使用的 Tool

项目串联 **10 个 Tool**，覆盖营养、价格、门店、订单、积分、券、活动七个数据域。

### 核心主打：每百元蛋白密度榜

| Tool | 用途 | 在计算链中的角色 |
|---|---|---|
| `query-meals` | 取门店实时菜单与 `currentPrice` | 提供实付价 |
| `list-nutrition-foods` | 取蛋白质、钠、能量等成分 | 提供蛋白质克数 |
| `query-store-coupons` | 取当前门店可用券 | 叠加用户专属优惠（可选） |

```
query-meals(storeCode, orderType=1, beType=1)
        ↓  data.meals[code].currentPrice / .name
list-nutrition-foods()
        ↓  productName → protein / sodium / energyKcal
餐名三级降级匹配
        ↓
蛋白密度 = protein(g) ÷ currentPrice(元) × 100
        ↓
按密度降序排名 + 计算中位数与相对比例
```

**关键点**：`query-meals` 返回的 `currentPrice` 已是实付价（`originalPrice` 为原价），因此默认无需再调用价格试算类工具。仅在需要叠加用户账户专属券时才启用 `query-store-coupons` 与价格试算。

### 此刻可点榜

| Tool | 用途 |
|---|---|
| `now-time-info` | 获取服务器当前完整时间 |
| `query-nearby-stores` | 查询附近门店及其营业时间 |
| `query-meals` | 逐店拉取实时菜单，计算多店交集 |

```
now-time-info()
        ↓
query-nearby-stores(beType=1, searchType=2, city, keyword, longitude, latitude)
        ↓  data[].businessStartTime / businessEndTime / reservationTimeOptions
营业状态判定（营业中 / 将打烊 / 已打烊）
        ↓
query-meals(storeCode) 逐店查询
        ↓  code 600057 打烊 → 捕获降级，不中断流程
多店菜单交集 + 三态呈现
```

**时段口径**：直接采用接口 `reservationTimeOptions[].reservationOptionText` 中的官方划分（如「早餐 06:14至10:15，午餐 10:44至14:15，下午茶 14:44至16:45，夜市 17:14至21:45」），不自行推断。

### 钠值分布榜

| Tool | 用途 |
|---|---|
| `list-nutrition-foods` | 取全量餐品钠含量 |
| `query-meal-detail` | 补充套餐组成与可替换项 |

基于全量营养表计算钠值分位，而非基于门店菜单 —— 因为此处关心的是「菜单上有什么」的分布，不是「此刻能买到什么」。

### 我的常点榜

| Tool | 用途 |
|---|---|
| `order-list` | 近期待店 / 外送历史订单 |
| `mall-order-list` | 麦麦商城近一年订单 |
| `query-my-coupons` | 账户可用优惠券 |
| `query-my-account` | 积分账户，含 `currentMouthExpirePoint`（本月将过期积分） |
| `now-time-info` | 计算距上次点单的间隔天数 |

**隐私约束**：以上均为用户账户数据，仅在运行时计算，**不存储、不上传、不写入任何文件**。榜单顶部常驻标注此承诺。

---

## 三、响应解析

MCP 响应存在三层嵌套：

```
result.content[0].text
  → "## Original Response" 标记的 JSON
    → data 字段可能是字符串化的 JSON 或 CSV，需二次解析
```

**实现策略**：优先读取 `result.structuredContent`（结构化，可靠）；仅在缺失时回退到文本解析，且文本中可能混入文档模板，需逐个尝试提取 JSON。

`list-nutrition-foods` 的 `data` 是特殊格式，形如：

```
[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
  猪柳麦满分,null,1288,308,16,16,24,781,213
```

需按行解析 CSV 并映射字段下标。实测有效餐品 158 项。**注意 `nutritionDescription` 字段全部为 null，不可用。**

---

## 四、餐名匹配策略

官方营养表（158 项）与门店实时菜单（122 项）存在版本差异，需匹配后才能联合计算。

### 三级降级

| 级别 | 规则 | 示例 |
|---|---|---|
| 一级 | 完全相等 | 巨无霸、麦香鸡、板烧鸡腿堡 |
| 二级 | 去除括号后相等 | 那么大鸡排（椒盐风味）→ 那么大鸡排 |
| 三级 | 一方包含另一方（需 ≥3 字符） | 培根安格斯厚牛堡 → 培根安格斯厚牛堡四件套 |
| 失败 | 标注「暂无营养数据」 | 龙焰鸡腿堡三件套、月下相思扭扭薯 |

**归一化规则只使用「去括号」一种**，不引入编辑距离或分词，避免过度模糊匹配导致错配。

三级包含匹配取**最短命中项**，避免「麦辣鸡腿汉堡」误配到「麦辣鸡腿汉堡三件套」。

### 实测覆盖率

| 指标 | 数值 |
|---|---|
| 门店在售餐品 | 122 |
| 成功匹配 | 63 |
| **覆盖率** | **51.6%** |
| 未匹配 | 59 |

### 处理原则

**宁可少算，不可错算。**

- 不猜测映射，不手工维护映射表
- 未匹配项独立分组置于榜单末尾，明确标注「暂无营养数据」
- **覆盖率在榜单顶部常驻显示，不可折叠**

覆盖率本身写入 README 与 UI，这是可信度来源而非缺陷 —— 主动披露数据缺口，比假装完整更诚实。

---

## 五、接口约束与错误处理

实测踩坑记录，实现中均已处理：

| 约束 / 错误码 | 表现 | 处理 |
|---|---|---|
| `orderType` 必传 | 缺失返回 400 | 固定传 `orderType=1` |
| `beType` 必传 | 缺失返回 400「beType1-到店取餐…」 | 默认传 `beType=1` |
| `beCode` 条件必传 | `beType=2/5/6` 时缺失返回 600048 | 仅使用 `beType=1` 通用场景 |
| `600057` | 门店可能已关闭或不在营业时间 | 调用前用营业时间预判；捕获后降级为推荐仍营业门店 |
| `429` | 触发限流 | 降低频率；多店查询采用串行而非并发 |
| `401` | Token 无效或过期 | 明确提示重新申请 |
| `searchType=1` | 收藏列表为空 | 改用 `searchType=2` + 城市 + 关键词 + 经纬度 |

---

## 六、业务价值

### 用户侧

- **降低决策成本**：把长菜单压缩为有序榜单，无需逐项比较
- **价格更准确**：基于实付价而非标价，反映用户账户实际优惠
- **信息可追溯**：每个数字来自明确的官方接口，不做推测补全
- **覆盖缺口透明**：数据缺失明确告知，不制造「看起来完整」的假象

### 设计侧

保留「卡片化榜单 + 多维排序 + 跳转下单」的成熟体验模式，但将数据源从主观 UGC 替换为客观接口数据，从而绕开冷启动问题，获得即开即用的可用性。

### 合规侧

项目在代码层实现自动合规检查（禁用词表、品牌对比扫描），所有输出在渲染后、输出前强制校验，命中即阻止输出。这保证了输出内容不会触碰规则中「宣扬不健康饮食方式」「与其他品牌对比」等条款。

---

## 七、非官方声明

本项目为麦当劳程序员创意开发大赛参赛作品，由参赛者独立开发，**非麦当劳官方产品**。

项目输出为客观数据对比，**不构成医疗、营养或其他专业建议**。餐品信息、价格及供应状态以麦当劳官方渠道的实时结果为准。

使用麦当劳 MCP 服务须遵守[麦当劳 MCP 服务规则](https://cdn.mcd.cn/cms/pages/MCPServerRules.html)，商标归属麦当劳所有。
