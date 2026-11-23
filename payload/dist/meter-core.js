(function (root) {
  'use strict';
  const number = value => value !== undefined && value !== null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  function parseDurationSec(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    const match = String(value).trim().match(/^([\d.]+)\s*s?$/i);
    if (!match) return null;
    const num = parseFloat(match[1]);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }

  function getModelPoolKey(raw) {
    if (!raw) return 'unknown';
    const s = String(raw).toLowerCase();
    if (s.includes('neon') || s.includes('gemini-4-neon')) return 'gemini-4-neon';
    if (s.includes('hydrogen') || s.includes('gemini-4-hydrogen')) return 'gemini-4-hydrogen';
    if (s.includes('carbon') || s.includes('gemini-4-carbon')) return 'gemini-4-carbon';
    if (s.includes('argon') || s.includes('gemini-4-argon')) return 'gemini-4-argon';
    if (s.includes('flash') || s.includes('gemini-3.8-flash')) return 'gemini-3.8-flash';
    if (s.includes('opus') || s.includes('claude-opus')) return 'claude-opus-5-5';
    if (s.includes('sonnet') || s.includes('claude-sonnet')) return 'claude-sonnet-5-5';
    if (s.includes('gpt-oss')) return 'gpt-oss-120b';
    return s.replace(/[^a-z0-9_-]/g, '');
  }

  function formatResetTimeZh(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return String(isoStr);
      const m = d.getMonth() + 1;
      const day = d.getDate();
      const h = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      return `${m}月${day}日 ${h}:${min}`;
    } catch {
      return String(isoStr);
    }
  }

  function resolveModelQuota(modelIdOrName, cascadeModelConfigs) {
    if (!Array.isArray(cascadeModelConfigs) || !cascadeModelConfigs.length || !modelIdOrName) {
      return null;
    }
    const poolKey = getModelPoolKey(modelIdOrName);
    const targetStr = String(modelIdOrName).toLowerCase();

    // 1. 优先精准匹配 modelId 或 label
    let matched = cascadeModelConfigs.find(c => {
      const mId = String(c.modelId || '').toLowerCase();
      const lbl = String(c.label || '').toLowerCase();
      return mId === targetStr || lbl === targetStr;
    });

    // 2. 匹配同一配额池
    if (!matched && poolKey !== 'unknown') {
      matched = cascadeModelConfigs.find(c => {
        const cPool = getModelPoolKey(c.modelId || c.label);
        return cPool === poolKey;
      });
    }

    if (!matched) return null;

    const qi = matched.quotaInfo || {};
    const poolNames = {
      'gemini-4-hydrogen': 'Gemini 4 Hydrogen 配额池',
      'gemini-4-carbon': 'Gemini 4 Carbon 配额池',
      'gemini-4-argon': 'Gemini 4 Argon 配额池（周限额）',
      'gemini-3.8-flash': 'Gemini 3.8 Flash 配额池',
      'claude-opus-5-5': 'Claude Opus 5.5 配额池',
      'claude-sonnet-5-5': 'Claude Sonnet 5.5 配额池',
      'gpt-oss-120b': 'GPT-OSS 120B 配额池'
    };

    return {
      modelId: matched.modelId || '',
      label: matched.label || modelIdOrName,
      poolKey,
      poolName: poolNames[poolKey] || (matched.label ? `${matched.label} 配额池` : '专属模型配额池'),
      remainingFraction: typeof qi.remainingFraction === 'number' ? qi.remainingFraction : null,
      resetTime: qi.resetTime || null
    };
  }

  function normalizeQuotaMatchText(raw) {
    return String(raw || '')
      .toLowerCase()
      .replace(/\((?:extra\s+high|xhigh|high|medium|low|minimal|max)\)/gi, ' ')
      .replace(/[^a-z0-9.]+/g, ' ')
      .replace(/(?:^|\s)\.+|\.+(?:\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const QUOTA_GROUP_STOP_WORDS = new Set([
    'model', 'models', 'quota', 'pool', 'group', 'limit', 'limits',
    'shared', 'and', 'the', 'all', 'weekly', 'daily', 'preview', 'beta', 'standard'
  ]);
  const QUOTA_VENDOR_WORDS = new Set(['gemini', 'claude', 'gpt', 'google', 'anthropic', 'openai']);

  function tokenizeQuotaText(raw) {
    const norm = normalizeQuotaMatchText(raw);
    const tokens = norm.split(' ').filter(t => t && !QUOTA_GROUP_STOP_WORDS.has(t));
    const specific = tokens.filter(t => !QUOTA_VENDOR_WORDS.has(t) && !/^\d+(?:\.\d+)?$/.test(t));
    return { norm, tokens, specific };
  }

  function findMatchedQuotaGroup(model, groups) {
    if (!Array.isArray(groups) || !groups.length) return null;
    const candidates = (Array.isArray(model) ? model : [model])
      .map(normalizeQuotaMatchText)
      .filter(Boolean);
    if (!candidates.length) return null;
    const combined = candidates.join(' ');
    const modelTokens = new Set(combined.split(' ').filter(Boolean));
    const hasToken = (tok) => modelTokens.has(tok);
    const isGeminiModel = hasToken('gemini') || combined.includes('gemini');
    const isFlashModel = hasToken('flash') || hasToken('lite');
    const isClaudeFamily = hasToken('claude') || hasToken('opus') || hasToken('sonnet') || hasToken('haiku') || hasToken('anthropic');
    const isGptFamily = hasToken('gpt') || hasToken('openai');

    const validGroups = groups
      .filter(entry => entry && typeof entry === 'object')
      .map(entry => {
        const rawName = String(entry.displayName || '').trim();
        const { norm: normName, tokens, specific: specificTokens } = tokenizeQuotaText(rawName);
        const normDesc = normalizeQuotaMatchText(entry.description || '');
        const clauses = rawName
          .split(/\s*(?:&|,|\/|\+|\band\b)\s*/i)
          .map(tokenizeQuotaText)
          .filter(c => c.tokens.length > 0);
        return { entry, normName, normDesc, tokens, specificTokens, clauses };
      });

    // 1. 优先匹配专属独立配额组（如 Pro 的 Gemini 4 Argon / Gemini 3 Pro / Gemini 3 Flash / Gemini 4 Neon & Carbon）
    // 若服务端对该账号未单独拆分 Argon 组（例如 Ultra 下 Argon 归入共享 Gemini Models），则继续向下回退匹配共享 Gemini 组
    if (hasToken('argon') || combined.includes('argon')) {
      const argonGroup = validGroups.find(g => g.tokens.includes('argon') || /\bargon\b/i.test(g.normName));
      if (argonGroup) return argonGroup.entry;
    }

    let bestSpecific = null;
    let bestSpecificScore = 0;
    for (const g of validGroups) {
      const isSharedClaudeGpt = (g.tokens.includes('claude') && g.tokens.includes('gpt'));
      if (isSharedClaudeGpt) continue;
      const groupVendors = g.tokens.filter(t => QUOTA_VENDOR_WORDS.has(t));
      const vendorOk = !groupVendors.length || groupVendors.some(v => modelTokens.has(v));
      if (!vendorOk) continue;

      for (const clause of g.clauses) {
        if (!clause.specific.length) continue;
        const clauseVendors = clause.tokens.filter(t => QUOTA_VENDOR_WORDS.has(t));
        if (clauseVendors.length && !clauseVendors.every(v => modelTokens.has(v))) continue;
        if (clause.specific.every(tok => modelTokens.has(tok))) {
          const score = clause.specific.length * 10 + clause.tokens.length;
          if (score > bestSpecificScore) {
            bestSpecificScore = score;
            bestSpecific = g.entry;
          }
        }
      }
    }
    if (bestSpecific) {
      return bestSpecific;
    }

    // 2. 尝试匹配 group.description 中明确列出的模型名（兼容 Pro/Free 改名分组如 Partner/Frontier Models）
    const descMatch = validGroups.find(g => {
      if (!g.normDesc) return false;
      return candidates.some(cand => cand.length >= 6 && g.normDesc.includes(cand));
    });
    if (descMatch) return descMatch.entry;

    // 3. 回退到厂商共享配额组（兼容 Ultra 通用 Gemini Models 与 Pro 拆分 Gemini Pro / Gemini Flash）
    if (isGeminiModel) {
      const geminiShared =
        validGroups.find(g => /^gemini(?:\s+\d+(?:\.\d+)?)?\s+models?$/i.test(g.normName)) ||
        validGroups.find(g => g.tokens.includes('gemini') && g.specificTokens.length === 0);
      if (geminiShared) return geminiShared.entry;
      // 若 Pro 仅拆分为 Gemini Pro + Gemini Flash 而无通用 Gemini Models，则按 Flash vs 非 Flash（Pro/Neon/Hydrogen/Carbon/Argon）兜底
      if (isFlashModel) {
        const flashGroup = validGroups.find(g => g.tokens.includes('gemini') && g.specificTokens.includes('flash'));
        if (flashGroup) return flashGroup.entry;
      } else {
        const proGroup = validGroups.find(g =>
          g.tokens.includes('gemini') &&
          g.specificTokens.includes('pro') &&
          !g.specificTokens.includes('flash') &&
          !g.specificTokens.includes('lite')
        );
        if (proGroup) return proGroup.entry;
      }
      return null;
    }

    if (isClaudeFamily || isGptFamily) {
      const sharedClaudeGpt = validGroups.find(g => /claude.*gpt|gpt.*claude/i.test(g.normName));
      if (sharedClaudeGpt) return sharedClaudeGpt.entry;
      const vendorGroup = validGroups.find(g =>
        (isClaudeFamily && g.tokens.includes('claude') && g.specificTokens.length === 0) ||
        (isGptFamily && g.tokens.includes('gpt') && g.specificTokens.length === 0)
      );
      if (vendorGroup) return vendorGroup.entry;
      const partnerGroup = validGroups.find(g => /\b(?:third\s*party|partner)\b/i.test(g.normName));
      return partnerGroup?.entry || null;
    }

    return null;
  }

  function resolveModelQuotaGroupBuckets(model, groups) {
    const group = findMatchedQuotaGroup(model, groups);
    if (!group || !Array.isArray(group.buckets)) return [];
    return group.buckets.filter(bucket => {
      const remaining = bucket?.remainingFraction;
      return !bucket?.disabled && Number.isFinite(remaining) && remaining >= 0 && remaining <= 1;
    });
  }

  function resolveModelQuotaGroup(model, groups) {
    const activeBuckets = resolveModelQuotaGroupBuckets(model, groups);
    return activeBuckets.reduce((tightest, bucket) => (
      !tightest || bucket.remainingFraction < tightest.remainingFraction ? bucket : tightest
    ), null);
  }

  function classifyRequestError(input, options = {}) {
    const error = typeof input === 'string' ? input : String(input?.error || input?.message || '');
    const currentModel = options.currentModel || '';
    const cascadeConfigs = options.cascadeModelConfigs || [];
    const modelQuota = resolveModelQuota(currentModel, cascadeConfigs);

    if (!error) {
      return {
        kind: 'none',
        title: '正常',
        badgeText: '正常',
        detail: '',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: modelQuota?.poolName || currentModel || null,
        diagnostic: ''
      };
    }

    // 脱敏清洗诊断摘要（去除非必要的完整 URL 和堆栈冗余）
    let diagnostic = error.replace(/https?:\/\/[^\s"']+/g, '<API>').trim();
    if (diagnostic.length > 120) diagnostic = diagnostic.slice(0, 117) + '...';

    // 1. 上下文容量超限 (Context Overflow)
    // 明确排除 Go context.DeadlineExceeded 网络超时
    const isDeadlineTimeout = /context deadline exceeded|deadline exceeded|stream idle timeout/i.test(error);
    const overflowMatch = !isDeadlineTimeout && error.match(/input token count exceeds|context\s*(?:window|length|tokens?|limit|size|capacity)?.{0,35}(?:exceed|too long)|maximum context length|prompt exceeds maximum context length|max_tokens exceeded/i);
    if (overflowMatch) {
      const serviceLimit = number(error.match(/(?:allowed|limit(?:\s+of)?|length(?:\s+is|\s+of)?)\s*[:=]?\s*([\d,]+)/i)?.[1]?.replaceAll(',', ''));
      return {
        kind: 'context_overflow',
        title: '超限告警',
        badgeText: '超限',
        detail: `输入超出模型容量上限${serviceLimit ? `（${serviceLimit} tokens）` : ''}，请精简上下文或新建会话`,
        serviceLimit,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 2. 模型或额度池耗尽 (Quota Exhausted)
    const explicitQuotaMatch = /(?:quota\s*(?:exceeded|reached|limit|exhausted)|out\s+of\s+quota|exhausted.*(?:capacity|quota)|resource_exhausted.*(?:quota|capacity|billing)|free\s+tier\s+quota|daily\s+quota|weekly\s+quota)/i.test(error);
    const quotaZeroEvidence = Boolean(modelQuota && typeof modelQuota.remainingFraction === 'number' && modelQuota.remainingFraction <= 0.0001);

    if (explicitQuotaMatch || quotaZeroEvidence) {
      const resetTimeZh = modelQuota?.resetTime ? formatResetTimeZh(modelQuota.resetTime) : null;
      const poolName = modelQuota?.poolName || (currentModel ? `${currentModel} 专属配额` : '模型配额');
      return {
        kind: 'quota_exhausted',
        title: '额度耗尽',
        badgeText: '额度耗尽',
        detail: `${poolName}额度已用尽${resetTimeZh ? `，预计 ${resetTimeZh} 重置` : ''}。可手动切换其他可用模型`,
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: modelQuota?.resetTime || null,
        resetTimeZh,
        modelOrPool: poolName,
        diagnostic
      };
    }

    // 3. 请求频率限制 (Rate Limited)
    const rateLimitMatch = /(?:rate\s*limit|too\s*many\s*requests|\b429\b|RateLimitError|RESOURCE_EXHAUSTED.*rate)/i.test(error);
    if (rateLimitMatch) {
      const retryMatch = error.match(/(?:retry\s+in|retry-after|wait)\s*[:=]?\s*([\d.]+)\s*(?:s|sec|seconds)?/i);
      const retryAfterSec = retryMatch ? parseFloat(retryMatch[1]) : null;
      return {
        kind: 'rate_limited',
        title: '请求限流',
        badgeText: '限流',
        detail: `请求过于频繁，触发服务端频率限制（429）${retryAfterSec ? `，建议等待 ${retryAfterSec} 秒后重试` : '，请稍候重试'}`,
        serviceLimit: null,
        retryAfterSec,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 4. 用户主动取消或请求中断 (Canceled)
    const canceledMatch = /(?:context canceled by user|user cancelled|request was aborted|AbortError)/i.test(error);
    if (canceledMatch) {
      return {
        kind: 'canceled',
        title: '已取消',
        badgeText: '已取消',
        detail: '本次生成请求已由用户或系统主动取消',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 5. 身份认证与权限错误 (Auth / Permission)
    const authMatch = /(?:UNAUTHENTICATED|PERMISSION_DENIED|\b401\b|\b403\b|invalid api key|credentials expired|permission denied)/i.test(error);
    if (authMatch) {
      return {
        kind: 'auth_error',
        title: '认证异常',
        badgeText: '认证',
        detail: '身份认证失败或缺少访问权限，请检查账号登录状态或订阅权限',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 6. 服务暂不可用 (Service Unavailable)
    const unavailMatch = /(?:UNAVAILABLE|\b503\b|\b502\b|\b504\b|server overloaded|high demand|Bad Gateway|Service Unavailable)/i.test(error);
    if (unavailMatch) {
      return {
        kind: 'service_unavailable',
        title: '服务受限',
        badgeText: '服务异常',
        detail: '模型服务暂时过载或不可用，请稍后重试',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 7. 明确网络连接失败或超时 (Network Error)
    const netMatch = /(?:\bEOF\b|idle timeout|deadline exceeded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|Failed to fetch|NetworkError)/i.test(error);
    if (netMatch) {
      let cleanNet = '连接失败或超时';
      if (/deadline exceeded|timeout/i.test(error)) cleanNet = '连接或读取超时';
      else if (/ECONNRESET|socket hang up/i.test(error)) cleanNet = '连接被对端重置';
      else if (/ECONNREFUSED/i.test(error)) cleanNet = '连接被拒绝';
      else if (/ENOTFOUND/i.test(error)) cleanNet = 'DNS 域名解析失败';
      else if (/\bEOF\b/i.test(error)) cleanNet = '服务端过早关闭连接 (EOF)';

      return {
        kind: 'network_error',
        title: '网络故障',
        badgeText: '网络',
        detail: `网络连接异常（${cleanNet}），请检查网络代理及本地连接`,
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 8. 兜底：原因待确认 (Unknown)
    return {
      kind: 'unknown',
      title: '原因待确认',
      badgeText: '待确认',
      detail: `请求失败，当前无法确认具体原因（${diagnostic}）`,
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      modelOrPool: currentModel || null,
      diagnostic
    };
  }

  function computeCacheMetrics(uncachedInput, cachedInput, options = {}) {
    const u = number(uncachedInput);
    const c = number(cachedInput);
    const uncached = u ?? 0;
    const cached = c ?? 0;
    const totalInputTokens = uncached + cached;
    if ((u === null && c === null) || totalInputTokens <= 0) return null;
    const hitRate = Number(((cached / totalInputTokens) * 100).toFixed(1));
    const turnCount = options?.turnCount != null && Number.isFinite(Number(options.turnCount))
      ? Number(options.turnCount)
      : null;
    let level = 'good';
    if ((turnCount === 1 && cached === 0) || totalInputTokens < 12000) {
      level = 'cold';
    } else if (hitRate < 25 && uncached >= 20000) {
      level = 'low';
    } else if (hitRate < 50 && uncached >= 15000) {
      level = 'warn';
    } else if (hitRate >= 75) {
      level = 'high';
    }
    return {
      hitRate,
      cachedTokens: cached,
      uncachedTokens: uncached,
      totalInputTokens,
      level
    };
  }

  function isSyntheticRecord(call) {
    if (!call || typeof call !== 'object') return false;
    if (call.isSynthetic === true) return true;
    const sId = String(call.callId || '').toLowerCase();
    const cId = String(call.cascadeId || '').toLowerCase();
    return sId.startsWith('test_') ||
      sId.startsWith('fixture_') ||
      sId.startsWith('synthetic_') ||
      sId.includes('desktop_response_001') ||
      cId.includes('verify') ||
      cId.includes('test') ||
      cId.includes('mock');
  }

  function summarizeSessionCache(calls) {
    if (!Array.isArray(calls) || !calls.length) return null;
    let uncachedTokens = 0;
    let cachedTokens = 0;
    let turns = 0;
    for (const call of calls) {
      if (!call || typeof call !== 'object') continue;
      if (isSyntheticRecord(call)) continue;
      const uncached = number(call.inputTokens ?? call.input_tokens) ?? 0;
      const cached = number(call.cacheReadTokens ?? call.cacheTokens ?? call.cache_read_tokens) ?? 0;
      if (uncached + cached <= 0) continue;
      uncachedTokens += uncached;
      cachedTokens += cached;
      turns += 1;
    }
    const totalInputTokens = uncachedTokens + cachedTokens;
    if (turns === 0 || totalInputTokens <= 0) return null;
    const hitRate = Number(((cachedTokens / totalInputTokens) * 100).toFixed(1));
    return {
      hitRate,
      cachedTokens,
      uncachedTokens,
      totalInputTokens,
      turns
    };
  }

  function summarize(metadata, options = {}) {
    const m = metadata?.chatModel;
    if (!m) return null;
    const lastRetry = (m.retryInfos || []).at(-1);
    const error = String(lastRetry?.error || m.error || '');
    const model = m.modelDisplayName || m.responseModel || m.model || options.currentModel || '';
    const modelRaw = String(m.model || m.modelOrAlias?.model || m.responseModel || m.modelDisplayName || options.currentModel || '').trim();
    const modelId = resolveStableModelId(m, options.cascadeModelConfigs || []) || resolveStableModelId(options.currentModel, options.cascadeModelConfigs || []) || null;

    // 执行结构化错误分类
    const classification = error ? classifyRequestError(error, {
      currentModel: model,
      cascadeModelConfigs: options.cascadeModelConfigs || [],
      userStatus: options.userStatus || null
    }) : { kind: 'none' };

    const exceeded = classification.kind === 'context_overflow';
    const network = classification.kind === 'network_error';
    const serviceLimit = classification.serviceLimit || null;

    const usage = lastRetry ? lastRetry.usage : m.usage;
    const input = number(usage?.inputTokens), cached = number(usage?.cacheReadTokens), output = number(usage?.outputTokens);
    const thinking = number(usage?.thinkingOutputTokens), responseTokens = number(usage?.responseOutputTokens);
    const hasInput = (input || 0) + (cached || 0) > 0;

    // 解耦维度：错误发生时不强制归零已有上下文用量
    const prevContext = options.previousValidContext || null;
    let actual = hasInput && !error ? (input || 0) + (cached || 0) + (output || 0) : null;
    if (actual === null && prevContext && prevContext.actual != null && !exceeded) {
      actual = prevContext.actual;
    }

    const context = m.chatStartMetadata?.contextWindowMetadata;
    const estimate = number(context?.estimatedTokensUsed) || prevContext?.estimate || null;
    const budget = number(context?.maxContextTokens) || prevContext?.budget || null;

    // 计算生成耗时与输出速度 (Tokens Per Second)
    const ttft = parseDurationSec(m.timeToFirstToken);
    const streamingSec = parseDurationSec(m.streamingDuration);
    const duration = (ttft !== null && streamingSec !== null) ? (ttft + streamingSec) : (ttft ?? streamingSec ?? null);
    let tps = null;
    if (output && duration && duration > 0) {
      tps = Number((output / duration).toFixed(1));
    }
    let streamingTps = null;
    if (output && streamingSec && streamingSec > 0.05) {
      streamingTps = Number((output / streamingSec).toFixed(1));
    }
    const speed = (tps !== null || duration !== null || output !== null) ? {
      tps,
      streamingTps,
      duration: duration !== null ? Number(duration.toFixed(2)) : null,
      ttft: ttft !== null ? Number(ttft.toFixed(2)) : null,
      streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(2)) : null,
      outputTokens: output ?? 0,
      thinkingTokens: thinking ?? 0,
      responseTokens: responseTokens ?? (output ?? 0)
    } : null;

    let status = 'pending';
    if (exceeded) status = 'exceeded';
    else if (network) status = 'network';
    else if (classification.kind === 'quota_exhausted') status = 'quota_exhausted';
    else if (classification.kind === 'rate_limited') status = 'rate_limited';
    else if (classification.kind === 'auth_error') status = 'auth_error';
    else if (classification.kind === 'service_unavailable') status = 'service_unavailable';
    else if (classification.kind === 'canceled') status = 'canceled';
    else if (error) status = 'failed';
    else if (actual !== null) status = 'reported';
    else if (estimate > 0) status = 'estimated';

    const usedVal = actual ?? (estimate > 0 ? estimate : null);
    const percentVal = actual !== null && budget > 0 && !exceeded ? (actual / budget * 100) : null;

    let inputVal = null;
    let uncachedVal = null;
    let cachedVal = 0;
    let cacheObj = null;
    if (hasInput && !error) {
      inputVal = (input || 0) + (cached || 0);
      uncachedVal = input || 0;
      cachedVal = cached || 0;
      cacheObj = computeCacheMetrics(uncachedVal, cachedVal, { turnCount: options.turnCount });
    } else if (!exceeded && prevContext && prevContext.input > 0) {
      inputVal = prevContext.input;
      cachedVal = prevContext.cached ?? 0;
      uncachedVal = prevContext.uncachedInput ?? Math.max(0, inputVal - cachedVal);
      cacheObj = prevContext.cache || computeCacheMetrics(uncachedVal, cachedVal, { turnCount: options.turnCount });
    } else if (hasInput && !exceeded) {
      inputVal = (input || 0) + (cached || 0);
      uncachedVal = input || 0;
      cachedVal = cached || 0;
      cacheObj = computeCacheMetrics(uncachedVal, cachedVal, { turnCount: options.turnCount });
    }

    return {
      used: usedVal,
      actual,
      estimate: estimate > 0 ? estimate : null,
      budget: budget > 0 ? budget : null,
      serviceLimit,
      exceeded,
      network,
      error,
      errorClassification: classification,
      estimated: actual === null,
      input: inputVal,
      uncachedInput: uncachedVal,
      cached: cachedVal,
      cacheHitRate: cacheObj ? cacheObj.hitRate : null,
      cache: cacheObj,
      output: output ?? (prevContext?.output ?? null),
      percent: percentVal,
      model,
      modelId,
      modelRaw,
      status,
      speed
    };
  }
  function measure(text) {
    text = String(text || '');
    let chars = 0, bytes = 0, cjk = 0;
    for (const char of text) { const c = char.codePointAt(0); chars++; bytes += c <= 127 ? 1 : c <= 2047 ? 2 : c <= 65535 ? 3 : 4; if (c >= 0x2e80 && c <= 0x9fff || c >= 0xf900 && c <= 0xfaff) cjk++; }
    const middle = (chars - cjk) / 4 + cjk * 1.2;
    return { chars, bytes, low: Math.ceil(middle * .7), high: Math.ceil(Math.max(middle * 1.6, bytes / 2)) };
  }
  function add(a, b) { for (const k of ['chars', 'bytes', 'low', 'high']) a[k] += b[k] || 0; return a; }
  const empty = () => ({ chars: 0, bytes: 0, low: 0, high: 0 });
  function analyzeSteps(steps) {
    const groups = { user: empty(), assistant: empty(), thinking: empty(), tools: empty(), summaries: empty() };
    const media = new Map();
    let userMessages = 0, assistantMessages = 0, latestStepError = null, lastUserAt = -1, lastAssistantAt = -1;
    const skip = new Set(['metadata', 'userConfig', 'lastUserConfig', 'userAgentSpec', 'activeUserState', 'thinkingSignature', 'thumbnail', 'inlineData', 'media', 'modelUsage', 'tokenUsage', 'mendelExperimentIds']);
    function content(value) {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (!value) return '';
      if (Array.isArray(value)) return value.map(content).join('\n');
      return Object.entries(value).filter(([key]) => !skip.has(key)).map(([key, v]) => `${key}: ${content(v)}`).join('\n');
    }
    function attachments(value, source, withinStep = new Set()) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const v of value) attachments(v, source, withinStep); return; }
      if (value.uri && (value.mimeType || value.inlineData !== undefined)) {
        const key = String(value.uri);
        if (!withinStep.has(key)) { withinStep.add(key); const prior = media.get(key); if (prior) prior.references++; else media.set(key, { uri: key, name: String(value.description || key.split(/[\\/]/).pop()), mime: String(value.mimeType || ''), references: 1, source }); }
      } else if (value.inlineData && !value.uri) {
        const key = `inline-${media.size}`;
        const rawData = typeof value.inlineData === 'string' ? value.inlineData : (value.inlineData.data || '');
        const mime = String(value.mimeType || value.inlineData.mimeType || '');
        if (!withinStep.has(key)) {
          withinStep.add(key);
          media.set(key, {
            uri: `inline:${key}`,
            inlineData: rawData,
            name: String(value.description || (mime.startsWith('image/') ? '内嵌图像' : '内嵌附件')),
            mime,
            references: 1,
            source
          });
        }
      }
      for (const [key, v] of Object.entries(value)) if (!skip.has(key) || key === 'media') attachments(v, source, withinStep);
    }
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.userInput) {
        userMessages++; lastUserAt = i;
        const u = s.userInput;
        add(groups.user, measure(u.userResponse || (u.items || []).map(item => item.text || '').join('\n')));
        // Canonical media and item inline previews represent the same upload.
        attachments(u.media?.length ? u.media : u.items, 'user');
      } else if (s.plannerResponse) {
        assistantMessages++; lastAssistantAt = i;
        add(groups.assistant, measure(s.plannerResponse.modifiedResponse || s.plannerResponse.response || ''));
        add(groups.thinking, measure(s.plannerResponse.thinking || ''));
        attachments(s.plannerResponse, 'assistant');
      } else if (s.errorMessage) {
        const e = s.errorMessage.error || {};
        latestStepError = { index: i, text: e.modelErrorMessage || e.shortError || e.fullError || '', id: e.errorId || '' };
      } else if (s.checkpoint) {
        add(groups.summaries, measure(s.checkpoint.sessionSummary || ''));
      } else {
        const payload = Object.fromEntries(Object.entries(s).filter(([k]) => !['type', 'status', 'metadata', 'error'].includes(k)));
        add(groups.tools, measure(content(payload)));
        attachments(payload, 'assistant');
      }
    }
    const total = Object.values(groups).reduce(add, empty());
    const currentError = latestStepError && latestStepError.index > Math.max(lastUserAt, lastAssistantAt) ? latestStepError : null;
    return { groups, total, media: [...media.values()], steps: steps.length, userMessages, assistantMessages, currentError };
  }

  function extractModelString(req) {
    if (!req) return '';
    if (typeof req === 'string') return req;
    const cm = req.chatModel;
    return cm?.modelDisplayName || cm?.responseModel || cm?.model || req.modelDisplayName || req.responseModel || req.model || req.chatModel || req.modelId || '';
  }

  function normalizeModelId(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const str = raw.trim().toLowerCase();
    if (str.includes('3.8-flash') || str.includes('3.8 flash') || str.includes('flash-n')) return 'gemini-3.8-flash';
    if (str.includes('4-argon') || str.includes('4 argon') || str.includes('argon')) return 'gemini-4-argon';
    if (str.includes('3.1-pro') || str.includes('3.1 pro')) return 'gemini-3.1-pro-preview';
    if (str.includes('3.5-flash-lite') || str.includes('3.5 flash-lite') || str.includes('flash-lite')) return 'gemini-3.5-flash-lite';
    if (str.includes('2.5-pro') || str.includes('2.5 pro')) return 'gemini-2.5-pro';
    return null;
  }

  /**
   * 解析准确模型标识用于按模型保存上下文偏好（不做计费家族归一化）
   * 优先级：精确 ID 字段 -> cascadeModelConfigs 精确 ID 匹配 -> 仅在无准确 ID 时按唯一 label 反查 -> 规范化原始标识
   */
  function resolveStableModelId(input, cascadeModelConfigs = []) {
    let idCandidates = [];
    let labelCandidates = [];

    if (typeof input === 'string') {
      const s = input.trim();
      if (!s) return null;
      idCandidates = [s];
      labelCandidates = [s];
    } else if (input && typeof input === 'object') {
      const cm = input.chatModel || input;
      const displaySet = new Set(
        [cm.modelDisplayName, cm.label]
          .filter(v => typeof v === 'string' && v.trim())
          .map(v => v.trim())
      );
      const rawIds = [
        cm.modelId,
        cm.modelOrAlias?.model,
        cm.modelRaw,
        cm.chatStartMetadata?.model,
        cm.responseModel,
        cm.model
      ];
      const seenId = new Set();
      for (const val of rawIds) {
        if (typeof val !== 'string') continue;
        const t = val.trim();
        if (!t || seenId.has(t)) continue;
        // summarize 结果里的 model 可能是纯显示名（与 modelDisplayName 相同），此时不应挤占准确 ID
        if (val === cm.model && displaySet.has(t) && (cm.modelId || cm.modelRaw || cm.modelOrAlias?.model)) {
          continue;
        }
        seenId.add(t);
        idCandidates.push(t);
      }
      labelCandidates = Array.from(displaySet);
    }

    if (!idCandidates.length && !labelCandidates.length) return null;

    const pickConfigCanonicalId = (cfg) => {
      const alias = String(cfg?.modelOrAlias?.model || '').trim();
      const mId = String(cfg?.modelId || '').trim();
      if (alias && mId) {
        // 若同一 alias 被多个不同 modelId（如 low/high 档位）共用，则以具体 modelId 区分档位；否则优先 alias
        const sameAliasCount = cascadeModelConfigs.filter(
          x => String(x?.modelOrAlias?.model || '').trim().toLowerCase() === alias.toLowerCase()
        ).length;
        return (sameAliasCount > 1 ? mId : alias).toLowerCase();
      }
      const chosen = alias || mId || String(cfg?.label || '').trim();
      return chosen ? chosen.toLowerCase() : null;
    };

    const stripModelPrefix = (v) => String(v || '').trim().toLowerCase().replace(/^model_/, '');

    if (Array.isArray(cascadeModelConfigs) && cascadeModelConfigs.length) {
      // 1. 优先按准确 ID 精确匹配（兼容 Protobuf MODEL_ 前缀，绝不受 label 文本影响）
      for (const cand of idCandidates) {
        const candLower = cand.toLowerCase();
        const candStripped = stripModelPrefix(cand);
        const matched = cascadeModelConfigs.find((c) => {
          const mId = String(c?.modelId || '').trim().toLowerCase();
          const aliasId = String(c?.modelOrAlias?.model || '').trim().toLowerCase();
          return (
            (mId && (mId === candLower || stripModelPrefix(mId) === candStripped)) ||
            (aliasId && (aliasId === candLower || stripModelPrefix(aliasId) === candStripped))
          );
        });
        if (matched) {
          return pickConfigCanonicalId(matched);
        }
      }

      // 2. 仅当没有任何可独立识别的准确 ID 时，才允许按唯一 label 反查
      const hasDistinctId = idCandidates.some(id => !labelCandidates.includes(id));
      if (!hasDistinctId) {
        for (const lblCand of labelCandidates) {
          const lblLower = lblCand.toLowerCase();
          const labelMatches = cascadeModelConfigs.filter(
            c => String(c?.label || '').trim().toLowerCase() === lblLower
          );
          if (labelMatches.length === 1) {
            return pickConfigCanonicalId(labelMatches[0]);
          }
        }
      }
    }

    const chosen = (idCandidates[0] || labelCandidates[0] || '').trim().toLowerCase();
    return chosen || null;
  }

  // 力度档位白名单（按长度降序排列，防止 Extra High / XHigh 被部分匹配为 High/Extra）
  const EFFORT_WHITELIST = ['Extra High', 'XHigh', 'Low', 'Medium', 'High', 'Extra', 'Minimal', 'Max'];
  const EFFORT_LABEL_ZH = {
    Low: '低（Low）',
    Medium: '中（Medium）',
    High: '高（High）',
    XHigh: '超高（XHigh）',
    Extra: '超高（Extra）',
    'Extra High': '超高（Extra High）'
  };
  const EFFORT_LABEL_TW = {
    Low: '低（Low）',
    Medium: '中（Medium）',
    High: '高（High）',
    XHigh: '超高（XHigh）',
    Extra: '超高（Extra）',
    'Extra High': '超高（Extra High）'
  };

  function normalizeEffortValue(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
    if (!s) return null;
    if (s === 'x high' || s === 'xhigh') return 'XHigh';
    for (const item of EFFORT_WHITELIST) {
      if (item.toLowerCase() === s) return item;
    }
    return null;
  }

  /**
   * 档位展示映射：默认/英文返回标准英文名（如 Extra High），中文面板按繁简返回对照标签
   * @param {string} effort 原始力度值
   * @param {string} [lang='en'] 语言代码（'en' | 'zh-CN' | 'zh-TW'）
   */
  function formatEffortLabel(effort, lang = 'en') {
    if (!effort) return '';
    const norm = normalizeEffortValue(effort);
    if (!norm) return String(effort);
    const l = typeof lang === 'string' ? lang.trim().toLowerCase() : 'en';
    if (l === 'zh-cn' || l === 'zh-hans' || l === 'zh') {
      return EFFORT_LABEL_ZH[norm] || norm;
    }
    if (l === 'zh-tw' || l === 'zh-hant' || l === 'tw') {
      return EFFORT_LABEL_TW[norm] || norm;
    }
    return norm;
  }

  /**
   * 按名称或准确 ID 前缀识别厂商（不使用模糊子串匹配）
   */
  function detectModelVendor(productLabel, modelId) {
    const candidates = [productLabel, modelId]
      .filter(v => typeof v === 'string' && v.trim())
      .map(v => v.trim().toLowerCase());
    for (const c of candidates) {
      if (c.startsWith('product:google:')) return 'Google';
      if (c.startsWith('product:anthropic:')) return 'Anthropic';
      if (c.startsWith('product:openai:')) return 'OpenAI';
      if (/^(?:models\/)?(?:gemini|google|gemma|imagen|veo)\b/.test(c)) return 'Google';
      if (/\b(?:gemini-4-)?(?:hydrogen|argon|carbon)\b/.test(c)) return 'Google';
      if (/^(?:models\/)?(?:claude|anthropic)\b/.test(c)) return 'Anthropic';
      if (/^(?:models\/)?(?:gpt|openai|o1|o3|o4|chatgpt|codex)\b/.test(c)) return 'OpenAI';
    }
    return '其他';
  }

  /**
   * 模型产品分组纯函数：
   * 将同一产品的不同力度档位归为同一个 productKey；
   * Carbon/Argon 等产品后缀、版本号与代际保持独立，不进行模糊合并。
   */
  function groupModelProduct(config) {
    const obj = (config && typeof config === 'object') ? config : { label: typeof config === 'string' ? config : '' };
    const cm = obj.chatModel || obj;
    const rawId = String(cm.modelId || cm.modelOrAlias?.model || cm.modelRaw || (typeof config === 'string' ? config : '') || '').trim();
    const rawLabel = String(cm.label || cm.modelDisplayName || cm.model || '').trim();
    const explicitEffort = normalizeEffortValue(cm.effort || cm.thinkingEffort || cm.reasoningEffort || obj.effort || '');

    let effort = explicitEffort;
    let productLabel = rawLabel;

    // 仅当末尾括号（半角或全角）或后缀属于白名单档位词时才拆分为 effort
    const effRegexParts = EFFORT_WHITELIST.map(e => e.replace(/\s+/g, '\\s+')).join('|');
    const parenRe = new RegExp(`^(.+?)\\s*[\\(（](${effRegexParts})[\\)）]\\s*$`, 'i');
    const suffixRe = new RegExp(`^(.+?)\\s+(${effRegexParts})\\s*$`, 'i');

    if (productLabel) {
      const mParen = productLabel.match(parenRe);
      if (mParen) {
        productLabel = mParen[1].trim();
        if (!effort) effort = normalizeEffortValue(mParen[2]);
      } else {
        const mSuffix = productLabel.match(suffixRe);
        if (mSuffix) {
          productLabel = mSuffix[1].trim();
          if (!effort) effort = normalizeEffortValue(mSuffix[2]);
        }
      }
    }

    if (!productLabel && rawId) {
      const idEffortRe = /^(.+?)[-_](extra[-_]?high|x[-_]?high|low|medium|high|extra|minimal|max)$/i;
      const mId = rawId.match(idEffortRe);
      if (mId) {
        productLabel = mId[1].trim();
        if (!effort) effort = normalizeEffortValue(mId[2]);
      } else {
        productLabel = rawId;
      }
    }

    if (!productLabel) productLabel = 'Unknown';
    const vendor = detectModelVendor(productLabel, rawId);
    const vendorSlugMap = { Google: 'google', Anthropic: 'anthropic', OpenAI: 'openai', 其他: 'other' };
    let slug = productLabel
      .toLowerCase()
      .replace(/[^a-z0-9.\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const pkMatch = rawId.toLowerCase().match(/^product:(google|anthropic|openai|other):(.+)$/);
    if (pkMatch && productLabel.toLowerCase() === rawId.toLowerCase()) {
      slug = pkMatch[2];
    }
    const productKey = `product:${vendorSlugMap[vendor] || 'other'}:${slug || rawId.toLowerCase() || 'unknown'}`;

    return {
      productKey,
      productLabel,
      vendor,
      effort: effort || null
    };
  }

  /**
   * 1000 进制 K 换算格式化，全项目统一口径（如 512000 -> 512K, 786432 -> 786.4K）
   */
  function formatTokensK(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const num = Number(v);
    if (num >= 1e6) return `${parseFloat((num / 1e6).toFixed(2))}M`;
    if (num >= 1000) return `${parseFloat((num / 1000).toFixed(1))}K`;
    return Math.round(num).toLocaleString('en-US');
  }

  /**
   * 判定单条记录是否为有效的实测速度样本
   */
  function isValidSpeedSample(call) {
    if (!call || typeof call !== 'object') return false;
    if (call.status !== 'final') return false;
    if (call.isEstimated === true || call.isSynthetic === true) return false;
    const out = Number(call.outputTokens);
    const dur = Number(call.durationSec);
    if (!Number.isFinite(out) || out <= 0) return false;
    if (!Number.isFinite(dur) || dur <= 0) return false;
    return true;
  }

  function computeMedian(values) {
    const clean = (Array.isArray(values) ? values : [])
      .map(Number)
      .filter(v => Number.isFinite(v))
      .sort((a, b) => a - b);
    if (!clean.length) return null;
    const mid = Math.floor(clean.length / 2);
    return clean.length % 2 === 1 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
  }

  const MAX_SPEED_SAMPLES_PER_MODEL = 200;

  /**
   * 按准确模型 ID（含档位）汇总速度对比统计（中位数、样本数、时间范围与折线序列）
   */
  function summarizeSpeedByModel(calls, options = {}) {
    const days = options.days;
    const originFilter = options.origin || 'all';
    const metric = options.metric || 'tps';
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const cutoffMs = (days === 7 || days === '7')
      ? nowMs - 7 * 86400000
      : (days === 30 || days === '30')
        ? nowMs - 30 * 86400000
        : null;
    const cascadeConfigs = Array.isArray(options.cascadeModelConfigs) ? options.cascadeModelConfigs : [];

    const groups = new Map();
    for (const c of (Array.isArray(calls) ? calls : [])) {
      if (!isValidSpeedSample(c)) continue;
      if (originFilter !== 'all') {
        const recOrigin = c.origin === 'speed-test' ? 'speed-test' : 'chat';
        if (recOrigin !== originFilter) continue;
      }
      const ts = Number(c.timestamp) || (c.created_at ? Date.parse(c.created_at) : 0) || (c.date ? Date.parse(c.date) : 0) || 0;
      if (cutoffMs !== null && (!ts || ts < cutoffMs)) continue;

      const exactId = String(c.modelExactId || resolveStableModelId(c, cascadeConfigs) || c.model || '').trim().toLowerCase();
      if (!exactId) continue;

      const rawLabel = String(c.modelLabel || c.model || exactId).trim();
      const prod = groupModelProduct({ modelId: exactId, label: rawLabel, effort: c.effort });
      const outputTokens = Number(c.outputTokens);
      const durationSec = Number(c.durationSec);
      const tpsVal = Number.isFinite(Number(c.tps)) && Number(c.tps) > 0
        ? Number(c.tps)
        : Number((outputTokens / durationSec).toFixed(1));
      const ttftVal = (c.ttftSec !== undefined && c.ttftSec !== null && Number.isFinite(Number(c.ttftSec)) && Number(c.ttftSec) >= 0)
        ? Number(c.ttftSec)
        : null;
      const streamingVal = (c.streamingSec !== undefined && c.streamingSec !== null && Number.isFinite(Number(c.streamingSec)) && Number(c.streamingSec) >= 0)
        ? Number(c.streamingSec)
        : null;
      const inVal = (c.inputTokens != null || c.cacheReadTokens != null || c.cacheTokens != null)
        ? (Number(c.inputTokens) || 0) + (Number(c.cacheReadTokens ?? c.cacheTokens) || 0)
        : null;

      if (!groups.has(exactId)) {
        groups.set(exactId, {
          modelExactId: exactId,
          modelLabel: rawLabel,
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          effort: c.effort || prod.effort || null,
          records: []
        });
      }
      const g = groups.get(exactId);
      g.records.push({
        callId: c.callId || null,
        ts,
        tps: tpsVal,
        ttftSec: ttftVal,
        streamingSec: streamingVal,
        durationSec,
        outputTokens,
        inputTokens: inVal,
        origin: c.origin === 'speed-test' ? 'speed-test' : 'chat'
      });
    }

    const result = [];
    for (const g of groups.values()) {
      // 按时间降序截断保留最近 200 条
      g.records.sort((a, b) => b.ts - a.ts);
      const recent = g.records.slice(0, MAX_SPEED_SAMPLES_PER_MODEL);
      if (!recent.length) continue;

      const medTps = computeMedian(recent.map(r => r.tps));
      const ttftList = recent.map(r => r.ttftSec).filter(v => v !== null);
      const medTtft = ttftList.length ? computeMedian(ttftList) : null;
      const medDur = computeMedian(recent.map(r => r.durationSec));
      const medOut = computeMedian(recent.map(r => r.outputTokens));
      const inList = recent.map(r => r.inputTokens).filter(v => v !== null && v > 0);
      const medIn = inList.length ? computeMedian(inList) : null;

      const tsList = recent.map(r => r.ts).filter(t => t > 0);
      const minTs = tsList.length ? Math.min(...tsList) : null;
      const maxTs = tsList.length ? Math.max(...tsList) : null;

      // 折线图使用时间升序排列
      const samples = recent.slice().sort((a, b) => a.ts - b.ts);

      result.push({
        modelExactId: g.modelExactId,
        modelLabel: g.modelLabel,
        productKey: g.productKey,
        productLabel: g.productLabel,
        vendor: g.vendor,
        effort: g.effort,
        count: recent.length,
        lowSample: recent.length < 3,
        medianTps: medTps !== null ? Number(medTps.toFixed(1)) : null,
        medianTtft: medTtft !== null ? Number(medTtft.toFixed(2)) : null,
        medianDuration: medDur !== null ? Number(medDur.toFixed(2)) : null,
        medianOutputTokens: medOut !== null ? Math.round(medOut) : null,
        medianInputTokens: medIn !== null ? Math.round(medIn) : null,
        minTs,
        maxTs,
        samples
      });
    }

    result.sort((a, b) => {
      if (metric === 'ttft') {
        if (a.medianTtft == null && b.medianTtft == null) return 0;
        if (a.medianTtft == null) return 1;
        if (b.medianTtft == null) return -1;
        return a.medianTtft - b.medianTtft;
      }
      if (metric === 'duration') {
        if (a.medianDuration == null && b.medianDuration == null) return 0;
        if (a.medianDuration == null) return 1;
        if (b.medianDuration == null) return -1;
        return a.medianDuration - b.medianDuration;
      }
      if (a.medianTps == null && b.medianTps == null) return 0;
      if (a.medianTps == null) return 1;
      if (b.medianTps == null) return -1;
      return b.medianTps - a.medianTps;
    });

    return result;
  }

  function parseGeneratorCall(row, cascadeId = null, source = 'desktop', options = {}) {
    if (!row || typeof row !== 'object') return null;
    const cm = row.chatModel || {};
    const u = cm.usage || {};
    const model = cm.modelDisplayName || cm.responseModel || cm.model || row.model || row.modelId || '';
    const modelKey = normalizeModelId(model);
    const cascadeConfigs = Array.isArray(options.cascadeModelConfigs) ? options.cascadeModelConfigs : [];
    const modelExactId = resolveStableModelId(row, cascadeConfigs) || resolveStableModelId(model, cascadeConfigs) || null;
    const modelLabelRaw = String(cm.modelDisplayName || row.modelLabel || model || modelExactId || '').trim();
    const productMeta = groupModelProduct({
      modelId: modelExactId || cm.modelId || cm.model || row.modelId,
      label: modelLabelRaw,
      effort: cm.effort || row.effort
    });

    const input = Number(u.inputTokens ?? row.inputTokens ?? row.input_tokens ?? 0);
    const cached = Number(u.cacheReadTokens ?? row.cacheTokens ?? row.cacheReadTokens ?? row.cache_read_tokens ?? 0);
    const output = Number(u.outputTokens ?? row.outputTokens ?? row.output_tokens ?? 0);
    const thinking = Number(u.thinkingOutputTokens ?? row.thinkingTokens ?? row.thinking_output_tokens ?? 0);
    const responseTokens = Number(u.responseOutputTokens ?? row.responseTokens ?? (output - thinking > 0 ? output - thinking : output));

    const callId = String(u.responseId || u.messageId || row.callId || row.responseId || (cascadeId ? `${cascadeId}#${(row.stepIndices?.[0] ?? row.stepIndex ?? 0)}` : ''));
    if (!callId) return null;

    // 完成状态管理：依据完成标记或耗时证据判定 final，流式中或只有部分文本时判定 streaming
    const hasExplicitFinish = Boolean(
      row.status === 'final' ||
      row.status === 'completed' ||
      cm.finishReason ||
      row.finishReason ||
      row.done === true ||
      (cm.streamingDuration != null && cm.timeToFirstToken != null)
    );
    const hasUsage = (input + cached + output) > 0;
    const status = hasExplicitFinish || (hasUsage && !row.isStreaming && row.status !== 'streaming') ? 'final' : 'streaming';
    const isEstimated = !hasUsage || output === 0;

    // 日期与时间戳：严格提取真实创建时间，不默认将历史记录替换为今天
    let callDate = null;
    let callTimestamp = null;
    const rawCreatedAt = row.created_at || row.createdAt || row.timestamp;
    if (rawCreatedAt) {
      const dt = new Date(rawCreatedAt);
      if (!Number.isNaN(dt.getTime())) {
        callDate = dt.toISOString().slice(0, 10);
        callTimestamp = dt.getTime();
      }
    } else if (row.date && /^\d{4}-\d{2}-\d{2}/.test(String(row.date))) {
      callDate = String(row.date).slice(0, 10);
      callTimestamp = new Date(callDate).getTime();
    } else if (source === 'desktop' && typeof window !== 'undefined') {
      callTimestamp = Date.now();
      callDate = new Date(callTimestamp).toISOString().slice(0, 10);
    }

    // 解析实测速度字段（绝不补零或估算缺失速度）
    const ttftSecRaw = parseDurationSec(cm.timeToFirstToken) ?? (row.ttftSec !== undefined && row.ttftSec !== null && Number.isFinite(Number(row.ttftSec)) && Number(row.ttftSec) >= 0 ? Number(row.ttftSec) : null);
    const streamingSecRaw = parseDurationSec(cm.streamingDuration) ?? (row.streamingSec !== undefined && row.streamingSec !== null && Number.isFinite(Number(row.streamingSec)) && Number(row.streamingSec) >= 0 ? Number(row.streamingSec) : null);
    let durationSecRaw = null;
    if (ttftSecRaw !== null && streamingSecRaw !== null) {
      durationSecRaw = ttftSecRaw + streamingSecRaw;
    } else if (ttftSecRaw !== null || streamingSecRaw !== null) {
      durationSecRaw = ttftSecRaw ?? streamingSecRaw;
    } else if (row.durationSec !== undefined && row.durationSec !== null && Number.isFinite(Number(row.durationSec)) && Number(row.durationSec) > 0) {
      durationSecRaw = Number(row.durationSec);
    }

    const speedFields = {};
    if (status === 'final' && !isEstimated && output > 0 && durationSecRaw !== null && durationSecRaw > 0) {
      if (ttftSecRaw !== null) speedFields.ttftSec = Number(ttftSecRaw.toFixed(2));
      if (streamingSecRaw !== null) speedFields.streamingSec = Number(streamingSecRaw.toFixed(2));
      speedFields.durationSec = Number(durationSecRaw.toFixed(2));
      speedFields.tps = (row.tps !== undefined && row.tps !== null && Number.isFinite(Number(row.tps)) && Number(row.tps) > 0)
        ? Number(Number(row.tps).toFixed(1))
        : Number((output / durationSecRaw).toFixed(1));
      speedFields.origin = row.origin === 'speed-test' ? 'speed-test' : 'chat';
    }

    const callRecord = {
      callId,
      source,
      cascadeId,
      model,
      modelKey,
      modelExactId: modelExactId || undefined,
      modelLabel: modelLabelRaw || undefined,
      effort: productMeta.effort || undefined,
      inputTokens: input,
      cacheTokens: cached,
      cacheReadTokens: cached,
      outputTokens: output,
      thinkingTokens: thinking,
      responseTokens,
      status,
      isEstimated,
      date: callDate,
      created_at: rawCreatedAt ? String(rawCreatedAt) : (callTimestamp ? new Date(callTimestamp).toISOString() : null),
      timestamp: callTimestamp,
      ...speedFields
    };
    return callRecord;
  }

  function parseUserPlanStatus(raw) {
    if (!raw || typeof raw !== 'object') {
      return {
        status: 'unidentified',
        tierKey: 'unknown',
        tierName: '未知',
        tierId: null,
        planName: '未知',
        email: null,
        promptCredits: null,
        flowCredits: null,
        updatedAt: null
      };
    }
    const us = raw.userStatus || raw;
    const userTier = us.userTier || {};
    const planStatus = us.planStatus || {};
    const planInfo = planStatus.planInfo || {};
    const email = us.email || null;
    const rawTierName = String(userTier.name || planInfo.planName || '').trim();

    // 只有具备明确权益证据时才识别套餐，避免空对象或缺省状态被当成 Free
    const hasTierEvidence = Boolean(
      rawTierName ||
      userTier.id ||
      planStatus.availablePromptCredits !== undefined ||
      planInfo.monthlyPromptCredits !== undefined
    );

    if (!hasTierEvidence) {
      return {
        status: 'unidentified',
        tierKey: 'unknown',
        tierName: '未知',
        tierId: null,
        planName: '未知',
        email,
        promptCredits: null,
        flowCredits: null,
        updatedAt: null
      };
    }

    let tierKey = 'unknown';
    let tierDisplayName = '未知';

    if (/ultra/i.test(rawTierName) || /ultra/i.test(userTier.id || '')) {
      tierKey = 'ultra';
      const subTierMatch = rawTierName.match(/ultra\s*([0-9a-zA-Z\-_]+)/i);
      if (subTierMatch && !['plan', 'tier'].includes(subTierMatch[1].toLowerCase())) {
        tierDisplayName = `Google AI Ultra (${subTierMatch[1]})`;
      } else {
        tierDisplayName = 'Google AI Ultra';
      }
    } else if (/pro/i.test(rawTierName) || /pro/i.test(userTier.id || '')) {
      tierKey = 'pro';
      tierDisplayName = 'Google AI Pro';
    } else if (/plus/i.test(rawTierName) || /plus/i.test(userTier.id || '')) {
      tierKey = 'plus';
      tierDisplayName = 'Google AI Plus';
    } else if (/free/i.test(rawTierName) || /free/i.test(userTier.id || '')) {
      tierKey = 'free';
      tierDisplayName = 'Free';
    } else {
      tierKey = 'custom';
      tierDisplayName = rawTierName || '未知套餐';
    }

    return {
      status: 'identified',
      tierKey,
      tierName: tierDisplayName,
      tierId: userTier.id || null,
      planName: planInfo.planName || tierDisplayName,
      email,
      promptCredits: {
        available: planStatus.availablePromptCredits ?? null,
        monthly: planInfo.monthlyPromptCredits ?? null
      },
      flowCredits: {
        available: planStatus.availableFlowCredits ?? null,
        monthly: planInfo.monthlyFlowCredits ?? null
      },
      updatedAt: new Date().toISOString()
    };
  }

  function resolveEffectivePlanStatus(livePlanStatus, customSettings, options = {}) {
    const rawLive = livePlanStatus && typeof livePlanStatus === 'object' ? livePlanStatus : null;
    const rawCustom = customSettings && typeof customSettings === 'object' ? customSettings : null;
    const cachedLive = options.cachedLivePlan && typeof options.cachedLivePlan === 'object' ? options.cachedLivePlan : null;

    const currentEmail = rawLive?.email || options.currentEmail || cachedLive?.email || null;
    const customAccount = rawCustom?.email || rawCustom?.account || null;

    const normCustomAcc = customAccount ? String(customAccount).trim().toLowerCase() : '';
    const normCurrentEmail = currentEmail ? String(currentEmail).trim().toLowerCase() : '';
    const isCustomAccountMatched = !normCustomAcc || normCustomAcc === 'default' || !normCurrentEmail || normCurrentEmail === 'default' || normCustomAcc === normCurrentEmail;
    const effectiveCustom = isCustomAccountMatched ? rawCustom : null;

    let status = 'unidentified';
    let tierKey = 'unknown';
    let tierName = '未知';
    let tierId = null;
    let planName = '未知';

    if (rawLive && rawLive.status === 'identified' && rawLive.tierKey !== 'unknown') {
      status = 'identified';
      tierKey = rawLive.tierKey;
      tierName = rawLive.tierName;
      tierId = rawLive.tierId;
      planName = rawLive.planName || rawLive.tierName;
    } else if (effectiveCustom && effectiveCustom.tierName) {
      status = 'custom';
      tierKey = effectiveCustom.tierKey || 'custom';
      tierName = effectiveCustom.tierName;
      planName = effectiveCustom.tierName;
    } else if (cachedLive && cachedLive.status === 'identified' && cachedLive.tierKey !== 'unknown') {
      status = 'identified';
      tierKey = cachedLive.tierKey;
      tierName = cachedLive.tierName;
      tierId = cachedLive.tierId;
      planName = cachedLive.planName || cachedLive.tierName;
    }

    const customNote = effectiveCustom?.customNote ? String(effectiveCustom.customNote).trim() : null;
    const promptCredits = rawLive?.promptCredits || cachedLive?.promptCredits || null;
    const flowCredits = rawLive?.flowCredits || cachedLive?.flowCredits || null;

    return {
      status,
      tierKey,
      tierName,
      tierId,
      planName,
      email: currentEmail,
      customNote,
      promptCredits,
      flowCredits,
      hasCustomSettings: Boolean(customNote),
      updatedAt: rawLive?.updatedAt || new Date().toISOString()
    };
  }

  function normalizeTokenHistoryPayload(payload, options = {}) {
    if (!payload || typeof payload !== 'object') return null;
    const source = options.source || 'all';

    const dailyMapBySource = payload.dailyMapBySource && typeof payload.dailyMapBySource === 'object'
      ? payload.dailyMapBySource
      : { all: payload.dailyMap || {}, desktop: {}, cli: {} };

    const targetMap = dailyMapBySource[source] || dailyMapBySource.all || payload.dailyMap || {};
    const normalizedMap = {};
    for (const [k, rec] of Object.entries(targetMap)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !rec) continue;
      normalizedMap[k] = {
        total: Number(rec.total) || 0,
        input: Number(rec.input) || 0,
        output: Number(rec.output) || 0,
        cache: Number(rec.cache) || 0,
        steps: Number(rec.steps) || 0
      };
    }

    const todayStr = options.todayStr || (new Date()).toISOString().slice(0, 10);
    const currentMonthPrefix = todayStr.slice(0, 7);
    const currentYearPrefix = todayStr.slice(0, 4);

    let grandTotalTokens = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheTokens = 0;
    let todayTokens = 0;
    let monthTokens = 0;
    let yearTokens = 0;
    let currentMonthInput = 0;
    let currentMonthOutput = 0;
    let currentMonthCache = 0;
    let activeDaysCount = 0;

    for (const [k, rec] of Object.entries(normalizedMap)) {
      if (rec.total > 0) activeDaysCount++;
      grandTotalTokens += rec.total;
      totalInputTokens += rec.input;
      totalOutputTokens += rec.output;
      totalCacheTokens += rec.cache;

      if (k === todayStr) todayTokens += rec.total;
      if (k.startsWith(currentMonthPrefix)) {
        monthTokens += rec.total;
        currentMonthInput += rec.input;
        currentMonthOutput += rec.output;
        currentMonthCache += rec.cache;
      }
      if (k.startsWith(currentYearPrefix)) {
        yearTokens += rec.total;
      }
    }

    const rawSum = payload.summary || {};
    if (source === 'all') {
      if (Number(rawSum.totalInputTokens) > totalInputTokens) totalInputTokens = Number(rawSum.totalInputTokens);
      if (Number(rawSum.totalOutputTokens) > totalOutputTokens) totalOutputTokens = Number(rawSum.totalOutputTokens);
      if (Number(rawSum.totalCacheTokens) > totalCacheTokens) totalCacheTokens = Number(rawSum.totalCacheTokens);
      if (Number(rawSum.grandTotalTokens) > grandTotalTokens) grandTotalTokens = Number(rawSum.grandTotalTokens);
      if (Number(rawSum.currentMonthInput) > currentMonthInput) currentMonthInput = Number(rawSum.currentMonthInput);
      if (Number(rawSum.currentMonthOutput) > currentMonthOutput) currentMonthOutput = Number(rawSum.currentMonthOutput);
      if (Number(rawSum.currentMonthCache) > currentMonthCache) currentMonthCache = Number(rawSum.currentMonthCache);
      if (Number(rawSum.monthTokens) > monthTokens) monthTokens = Number(rawSum.monthTokens);
    }

    const summary = {
      grandTotalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCacheTokens,
      todayTokens,
      monthTokens,
      yearTokens,
      currentMonthInput,
      currentMonthOutput,
      currentMonthCache,
      activeDaysCount,
      totalConversations: Number(rawSum.totalConversations) || activeDaysCount,
      firstUseDate: payload.firstUseDate || rawSum.firstUseDate || null
    };

    return {
      schemaVersion: payload.schemaVersion || '0.8.3',
      version: payload.version || '0.8.3',
      updatedAt: payload.updatedAt || '',
      firstUseDate: summary.firstUseDate,
      currentPeriod: payload.currentPeriod || {
        key: currentMonthPrefix,
        label: `${currentMonthPrefix} (自然月)`,
        isCurrentMonth: true
      },
      planStatus: payload.planStatus || null,
      rawPlanStatus: payload.rawPlanStatus || payload.planStatus || null,
      customPlanSettings: payload.customPlanSettings || null,
      summary,
      dailyMap: normalizedMap,
      dailyMapBySource
    };
  }

  /**
   * 按周期统计级别映射热力图 5 档色阶 (0..4)
   * @param {number} value - 当前 Token 用量
   * @param {'day'|'week'|'month'} [kind='day'] - 统计周期
   * @param {number} [maxInWindow=0] - 本窗口最大值 (week/month 模式下用于相对分位计算)
   * @returns {number} 0..4 对应的档位索引
   *
   * 分位策略说明：
   * - day: 采用每日绝对阈值 (0, <3M, <15M, <60M, >=60M)，保障单日细粒度用量感知。
   * - week / month: 采用相对本窗口最大值分位 (0: 0, <=25%: 1, <=50%: 2, <=75%: 3, >75%: 4)，
   *   自适应对比不同周期用量，避免月/周用量套用日阈值造成全部打满峰值色阶。
   */
  function getLvlForRange(value, kind = 'day', maxInWindow = 0) {
    const v = Number(value) || 0;
    if (v <= 0) return 0;
    if (kind === 'day') {
      if (v < 3e6) return 1;
      if (v < 15e6) return 2;
      if (v < 60e6) return 3;
      return 4;
    }
    const max = Number(maxInWindow) || 0;
    if (max <= 0) return 1;
    const ratio = v / max;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.50) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  }

  /**
   * 统计指定日期集合的纯 Token 聚合指标
   * @param {Object} dailyMap - 每日记录映射
   * @param {string[]} dateKeys - 参与统计的日期键列表 (YYYY-MM-DD)
   * @param {Object} [options={}] - 配置参数 (todayStr)
   */
  function calculateIntervalTokens(dailyMap = {}, dateKeys = [], options = {}) {
    const todayStr = options.todayStr || (new Date().toISOString().slice(0, 10));
    let totalTokens = 0;
    let inputTokens = 0;
    let cacheTokens = 0;
    let outputTokens = 0;
    let pastDays = 0;
    let activeDays = 0;

    for (const key of dateKeys) {
      const isFuture = key > todayStr;
      if (!isFuture) {
        pastDays++;
      }
      const rec = dailyMap[key];
      if (rec && rec.total > 0) {
        activeDays++;
        totalTokens += rec.total;
        inputTokens += (rec.input || 0);
        cacheTokens += (rec.cache || 0);
        outputTokens += (rec.output || 0);
      }
    }

    const safePastDays = Math.max(1, pastDays);
    const dailyAverageTokens = Math.round(totalTokens / safePastDays);
    const activeDailyAverageTokens = activeDays > 0 ? Math.round(totalTokens / activeDays) : 0;
    const totalInputAndCache = inputTokens + cacheTokens;
    const cacheHitRate = totalInputAndCache > 0
      ? Number(((cacheTokens / totalInputAndCache) * 100).toFixed(1))
      : null;

    return {
      totalTokens,
      inputTokens,
      cacheTokens,
      outputTokens,
      cacheHitRate,
      pastDays,
      activeDays,
      dailyAverageTokens,
      activeDailyAverageTokens
    };
  }

  /**
   * 解析严格 v0.x.x 格式的语义化版本
   * 防御性要求：只接受 ^v0\.\d+\.\d+$，任何 v2.x 或其他前缀均返回 null
   */
  function parseSemver(tag) {
    if (!tag || typeof tag !== 'string') return null;
    const m = tag.trim().match(/^v?0\.(\d+)\.(\d+)$/);
    if (!m) return null;
    return { major: 0, minor: parseInt(m[1], 10), patch: parseInt(m[2], 10) };
  }

  /**
   * 语义化版本对比
   * @returns {number} 1 (vA > vB), -1 (vA < vB), 0 (相等或无法对比)
   */
  function compareVersions(vA, vB) {
    const a = parseSemver(vA);
    const b = parseSemver(vB);
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
    if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
    return 0;
  }

  /**
   * 过滤并筛选可用更新 Release
   */
  function filterReleases(releasesList, currentVersion = '0.8.3') {
    if (!Array.isArray(releasesList)) return [];
    const valid = [];
    for (const rel of releasesList) {
      if (!rel || rel.draft || rel.prerelease) continue;
      const parsed = parseSemver(rel.tag_name);
      if (!parsed) continue; // 忽略非 v0.x 编号
      const verStr = `0.${parsed.minor}.${parsed.patch}`;
      if (compareVersions(verStr, currentVersion) > 0) {
        valid.push({
          tagName: rel.tag_name,
          version: verStr,
          htmlUrl: rel.html_url,
          body: rel.body || '',
          publishedAt: rel.published_at || '',
          assets: Array.isArray(rel.assets) ? rel.assets : []
        });
      }
    }
    valid.sort((a, b) => compareVersions(b.version, a.version));
    return valid;
  }

  /**
   * 在 Release 资产中按当前平台与架构寻找对应 ZIP 及校验文件
   */
  function findReleaseAsset(assets, platform, arch) {
    if (!Array.isArray(assets)) return { packageAsset: null, checksumAsset: null, targetOs: 'windows', targetArch: 'amd64' };
    const p = String(platform || '').toLowerCase();
    const a = String(arch || '').toLowerCase();
    const targetOs = (p === 'win32' || p === 'windows') ? 'windows' : ((p === 'darwin' || p === 'macos') ? 'darwin' : 'linux');
    const targetArch = (a === 'x64' || a === 'amd64') ? 'amd64' : 'arm64';

    let checksumAsset = null;
    let packageAsset = null;

    for (const item of assets) {
      const name = item.name || '';
      if (name === 'checksums.txt') {
        checksumAsset = item;
      } else if (name.endsWith('.zip') && name.includes(`_${targetOs}_${targetArch}`)) {
        packageAsset = item;
      }
    }

    return { packageAsset, checksumAsset, targetOs, targetArch };
  }

  /**
   * 严格校验外部链接是否属于官方白名单（本项目仓库或原作者帖子/主页）
   */
  function isValidExternalUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== 'https:') return false;
      if (u.hostname === 'github.com') {
        const pathname = u.pathname.replace(/\/+$/, '');
        const repoPrefix = '/cli117/antigravity-hakimi';
        return pathname === repoPrefix || pathname.startsWith(repoPrefix + '/');
      }
      if (u.hostname === 'linux.do') {
        const pathname = u.pathname.replace(/\/+$/, '');
        return (
          pathname === '/t/topic/3117832' ||
          pathname === '/t/3117832' ||
          pathname.startsWith('/t/topic/3117832/') ||
          pathname === '/u/23375/summary' ||
          pathname === '/u/23375'
        );
      }
      return false;
    } catch {
      return false;
    }
  }

  const api = {
    summarize,
    computeCacheMetrics,
    summarizeSessionCache,
    classifyRequestError,
    resolveModelQuota,
    resolveModelQuotaGroup,
    resolveModelQuotaGroupBuckets,
    formatResetTimeZh,
    measure,
    add,
    empty,
    analyzeSteps,
    parseDurationSec,
    normalizeModelId,
    resolveStableModelId,
    EFFORT_WHITELIST,
    formatEffortLabel,
    detectModelVendor,
    groupModelProduct,
    formatTokensK,
    isValidSpeedSample,
    computeMedian,
    summarizeSpeedByModel,
    MAX_SPEED_SAMPLES_PER_MODEL,
    resolveEffectivePlanStatus,
    parseUserPlanStatus,
    parseGeneratorCall,
    extractModelString,
    normalizeTokenHistoryPayload,
    getLvlForRange,
    calculateIntervalTokens,
    parseSemver,
    compareVersions,
    filterReleases,
    findReleaseAsset,
    isValidExternalUrl
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__AGContextMeterCore = api;
})(globalThis);
