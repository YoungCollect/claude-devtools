## 1.reAct

ReAct（Reasoning + Acting）是一种交互范式，来自论文 *ReAct: Synergizing Reasoning and Acting in Language Models*（Yao et al., 2022）。核心思想：让 LLM 在"推理"和"行动"之间交替进行，而不是一次性想完再做，或者只做不想。

### 核心循环

```
   ┌─────────────────────────────────────────────┐
   │                                               │
   ▼                                               │
[Thought]  推理：分析当前状态，判断任务是否完成，       │
   │        没完成的话决定下一步要做什么                │
   │                                               │
   ▼                                               │
[Action]   行动：调用一个工具 / 执行一个操作             │
   │                                               │
   ▼                                               │
[Observation] 观察：拿到工具执行的结果 / 环境反馈         │
   │                                               │
   └──────────── 未完成，回到 Thought ────────────────┘
   │
   ▼（判断已完成）
[Final Answer] 输出最终结果
```

- **输入**：一个任务 / 问题（Question / Task）
- **Thought → Action → Observation** 三步循环，可重复多轮
- **终止条件**：Thought 阶段判断任务已完成，跳出循环，给出 Final Answer

### 和 LLM loop / Agent loop 的对应关系

ReAct 的三步正好把前面拆的"判断层"和"执行层"具象化了：

| ReAct 步骤 | 对应角色 | 说明 |
| --- | --- | --- |
| Thought | LLM loop | 模型自己判断"完成了没有 + 下一步做什么"，纯推理，不产生外部效果 |
| Action | Agent loop（执行侧） | 把模型决定的动作真正执行出去（调用工具 / API） |
| Observation | Agent loop（回传侧） | 把执行结果重新喂回给模型，形成下一轮 Thought 的输入 |

所以 ReAct 流程图本质上就是 LLM loop（Thought）与 Agent loop（Action + Observation）交替驱动、首尾相接形成的那个循环——画图时可以把 Thought 节点标成"模型侧"，Action/Observation 节点标成"Client/Harness 侧"，直观体现两层的分工。

## 2.LLM Loop & Agent Loop

这里其实是"判断"和"执行"两层，容易混在一起，拆开看：

**LLM loop**：模型自身的能力体现。每一轮生成时，LLM 要判断当前任务是否完成；如果没完成，要决定下一步该做什么（调用哪个工具 / 用什么方式继续交互）。这个"是否完成 + 下一步做什么"的判断力，是模型训练出来的 agentic 能力，不是 Client 赋予的。

**Agent loop**：把这个判断真正落地成多轮交互链路的机制——执行 LLM 要求的工具、把结果回传、再次调用模型、维护上下文和状态。这一层是 Client 端提供的，模型自己无法执行工具、无法把结果传回给自己。

两者关系：**LLM loop 提供"循环该不该继续、下一步做什么"的决策逻辑；Agent loop 提供"循环怎么真正跑起来"的执行框架**。二者缺一不可——只有判断力没有执行框架，模型没法真正调用工具；只有执行框架没有判断力，Client 也不知道该在什么时候喂什么、什么时候该停。

（注：单次 API 调用本身——即一次自回归生成，哪怕带 extended thinking——不是"循环"，只是一次推理过程；"LLM loop"指的是这个判断力在多轮之间反复起作用，不是指单次生成内部有循环。）

## 3.Agent Loop => Harness

Agent loop 属于 Harness 的范畴

此外，Harness 还包括其他的能力，比如：

Context Management    
Memory                
Permissions           
Tool Runtime          
Sandbox               
State / Checkpoint    
Session               
Observability         
Retry / Error Handling
Cost / Token Management
Sub-agent Orchestration
command(/loop /goal) 
等等

## 4.Loop engineering

### 4.1 起源

"循环驱动 agent"这个技术最早能追溯到 Geoffrey Huntley 在 2025 年发表的文章 *Ralph Wiggum as a software engineer*。他把"用一个循环反复把同一个目标喂给 agent，直到任务完成"的做法称为 **Ralph loop / Ralph 技术**：

> "Ralph is a technique. In its purest form, Ralph is a Bash loop."

这本质上就是一个不断调用模型、直到任务完成才退出的 Bash 循环，是后来 "loop engineering" 概念的技术雏形。

这个概念真正出圈、成为行业热词是在 2026 年年中：

- **Boris Cherny**（Claude Code 作者）在 Anthropic 开发者大会上说过一句被广泛引用的话："I don't prompt Claude anymore. I have loops running that prompt Claude... My job is to write loops."（我不再亲自 prompt Claude 了，是循环在替我 prompt，我的工作是写循环。）
- **Peter Steinberger**（`openclaw` 创始人）在 2026-06-07 发推："you shouldn't be prompting coding agents anymore. You should be designing loops that prompt your agents."，这条推文一天内浏览量达数百万，是"loop engineering"这个词真正破圈的节点。
- **Addy Osmani**（前 Google）随后写博客系统梳理了这个概念，给出一个常被引用的定义："Loop engineering is replacing yourself as the person who prompts the agent. You design the system that does it instead."（loop engineering 就是把"负责 prompt agent 的人"这个角色替换掉——不再由你亲自去 prompt，而是由你设计一个系统去做这件事。）
- **Andrew Ng** 也在推特上跟进讨论，指出这一波热度正是由 Cherny 和 Steinberger 的两次出圈发言接力带起来的。

这波讨论直接推动了产品层面的落地：主流 agent harness 陆续上线了 `/goal` 命令——Codex（2026-04）、Hermes（2026-05-02）、Claude Code（2026-05-12）——把"设定目标、循环直到达成"做成了一等公民的产品能力（对应本文档第 5 节）。

Steinberger 本人后来把这个思路进一步延伸，提出了 "graph engineering"：让多个 agent 组成的组织本身变得可编程。这是 loop engineering 在多 agent 场景下的自然延伸，超出了本文档的讨论范围，仅作记录。

### 4.2 概念

Loop engineering 其实针对的是 workflow 的设计。

它的主要目标是：设定一个目标，设计一个循环，直到达到目标。

因此，它其实从概念上和实现上，更加符合 `/goal` 而非 `/loop`。

> 注：Loop engineer 名字里虽然带"loop"，但"重复执行"本身并不是难点（`/loop` 一行就能做到）。它真正的工程价值在于**目标判定（goal check）逻辑**——即"循环该在什么时候停"，这部分语义完全落在 `/goal` 上，而不在 `/loop`。


## 5./loop & /goal

Agent 中提供了 `/loop` 和 `/goal` 两个命令，分别用于启动循环和设置目标。

### /loop

```shell
/loop [interval] [prompt]
```

`/loop` 命令用于循环执行任务，**无结束条件**。


### /goal

```shell
/goal [goal]
```

`/goal` 命令用于设定一个目标，循环执行直到达成该目标，**有结束条件**（目标达成判定）。

### 对照

|      | 触发方式   | 结束条件         |
| ---- | ---------- | ---------------- |
| /loop | 固定间隔重复 | 无（需手动停止）   |
| /goal | 目标判定驱动 | 有（目标达成即停） |

## 番外：Ralph loop 与 /goal 的工作原理对比

`/goal` 出现之前，"循环直到目标达成"是靠 Ralph loop 这种手搓方案实现的。两者看起来功能类似，但**循环的边界**和**状态怎么传递**是完全不同的实现思路。

### Ralph loop：进程级循环 + 文件系统传状态

Ralph loop 的原型就是一个包住 agent CLI 的 Bash 循环，形如：

```bash
while true; do
  claude -p "$(cat PROMPT.md)"     # 每次都是全新进程、全新上下文
  ./run-tests.sh && break          # 外部脚本判定：测试全绿就退出
done
```

```bash
while true; do
  feedback=$(./run-tests.sh 2>&1)

  if [ $? -eq 0 ]; then
    break
  fi

  claude -p "
$(cat PROMPT.md)

Previous test result:
$feedback

Please fix the problem.
"
done
```

关键点：

- **每一轮都是一次独立、无记忆的调用**——agent 进程退出后上下文就丢了，下一轮是全新的一次对话，模型对"上一轮做了什么"没有直接记忆。
- **状态靠文件系统 / git 传递，不靠对话上下文**：agent 把进度写进代码本身、TODO.md、commit 历史里；下一轮的 agent 靠读这些文件"回忆"进度，所以 prompt 里通常会要求它先读 `AGENTS.md`/进度文件再干活。
- **目标判定发生在 agent 之外**：由外部脚本决定要不要停——跑测试套件、grep 一个约定的哨兵字符串或标记文件、或者单纯到达预算/轮数上限就退出。模型本身并不参与"是否该停"这个判断，它只管执行当前这一轮拿到的 prompt。

### /goal：session 内循环 + harness 原生维护上下文

`/goal` 则是把这套机制收编进 harness，在**同一个 session 内部**做循环，而不是反复起新进程：

- **上下文在多轮之间是连续的**：harness（Agent loop）维护同一份对话状态，每一轮都能看到之前所有轮次做过什么，不需要靠文件系统"找回记忆"。
- **目标判定回到了模型侧（LLM loop）**：呼应本文档第 1、2 节的 ReAct 模型——每一轮模型自己做类似 Thought 的判断："目标达成了吗？没达成的话下一步做什么？" harness 只负责把这个判断真正执行成下一轮 Action，并把结果（Observation）喂回去，循环往复直到模型判定目标达成或达到预算上限。
- **不需要靠约定的哨兵文件/字符串来传递"完成"信号**——因为判定逻辑就活在模型和 harness 的这次持续会话里，是 harness 原生托管的能力，而不是外部脚本临时拼凑的。

### 小结

| | Ralph loop | /goal |
| --- | --- | --- |
| 循环粒度 | 进程级（每轮全新上下文） | Session 级（多轮共享上下文） |
| 状态传递 | 文件系统 / git commit | Harness 维护的对话状态 |
| 目标判定主体 | 外部脚本（测试、grep、轮数上限） | 模型自身（LLM loop）+ harness 托管 |
| 本质 | 手搓的工程 hack | Harness 原生一等公民能力 |

