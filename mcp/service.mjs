import {
  allowedCategories,
  allowedTags,
  maximumSubmissionTags,
  submissionChecklist,
  submissionTitlePrefix,
} from "../scripts/submission.mjs";
import {
  foldSearchTerm,
  matchesDirectSearch,
  normalizeSearchTerm,
} from "../site/assets/js/search.js";
import { analyzeDuplicates } from "./duplicates.mjs";
import { MarketplaceMcpError } from "./errors.mjs";
import { compactPlugin, detailedPlugin, pluginById } from "./state.mjs";

const pluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const fullCommitPattern = /^[a-f0-9]{40}$/i;
const toolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export const toolDefinitions = Object.freeze([
  {
    name: "search_plugins",
    title: "Search marketplace plugins",
    description: "Search the current marketplace catalog by title, ID, description, author, category, tags, kind, verification state, and install availability.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 160 },
        category: { type: "string", enum: allowedCategories },
        tags: { type: "array", items: { type: "string", enum: allowedTags }, maxItems: 3, uniqueItems: true },
        kind: { type: "string", maxLength: 64 },
        verificationStatus: { type: "string", enum: ["verified", "unverified"] },
        installAvailable: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      },
    },
    annotations: toolAnnotations,
  },
  {
    name: "get_plugin",
    title: "Get plugin details",
    description: "Return the complete public catalog record for one exact marketplace plugin ID, including install, verification, source, and preview metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { pluginId: { type: "string", pattern: pluginIdPattern.source, maxLength: 128 } },
      required: ["pluginId"],
    },
    annotations: toolAnnotations,
  },
  {
    name: "find_similar_plugins",
    title: "Find duplicate or related plugins",
    description: "Check exact repository and plugin-ID conflicts, then rank advisory catalog similarities by title, description, taxonomy, and author.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repository: { type: "string", format: "uri", maxLength: 300 },
        repositoryNodeId: { type: "string", maxLength: 200 },
        repositoryDatabaseId: { type: "integer", minimum: 1 },
        id: { type: "string", pattern: pluginIdPattern.source, maxLength: 128 },
        name: { type: "string", maxLength: 120 },
        description: { type: "string", maxLength: 500 },
        author: { type: "string", maxLength: 120 },
        category: { type: "string", enum: allowedCategories },
        tags: { type: "array", items: { type: "string", enum: allowedTags }, maxItems: 3, uniqueItems: true },
        kind: { type: "string", maxLength: 64 },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 8 },
      },
      anyOf: [
        { required: ["repository"] },
        { required: ["id"] },
        { required: ["name"] },
        { required: ["description"] },
      ],
    },
    annotations: toolAnnotations,
  },
  {
    name: "review_candidate",
    title: "Review a plugin candidate",
    description: "Inspect a public GitHub plugin repository at an exact resolved commit, validate metadata and documentation, and compare it with existing listings. Does not execute code or provide a security verdict.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repository: { type: "string", format: "uri", maxLength: 300 },
        commit: { type: "string", pattern: fullCommitPattern.source },
        submissionTitle: { type: "string", maxLength: 160 },
        category: { type: "string", enum: allowedCategories },
        tags: { type: "array", items: { type: "string", enum: allowedTags }, maxItems: 3, uniqueItems: true },
        similarityLimit: { type: "integer", minimum: 1, maximum: 25, default: 8 },
      },
      required: ["repository"],
    },
    annotations: { ...toolAnnotations, openWorldHint: true },
  },
  {
    name: "get_preview",
    title: "Get a plugin preview image",
    description: "Return an existing marketplace preview or an exact-commit candidate preview as MCP image content for visual inspection.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        pluginId: { type: "string", pattern: pluginIdPattern.source, maxLength: 128 },
        repository: { type: "string", format: "uri", maxLength: 300 },
        commit: { type: "string", pattern: fullCommitPattern.source },
      },
      oneOf: [
        { required: ["pluginId"] },
        { required: ["repository", "commit"] },
      ],
    },
    annotations: { ...toolAnnotations, openWorldHint: true },
  },
]);

function objectArguments(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MarketplaceMcpError("invalid-arguments", "Tool arguments must be a JSON object.");
  }
  const unexpected = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unexpected) {
    throw new MarketplaceMcpError("invalid-arguments", `Unexpected tool argument "${unexpected}".`);
  }
  return value;
}

function optionalString(value, field, maximum, { required = false } = {}) {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new MarketplaceMcpError("invalid-arguments", `${field} must be a non-empty string up to ${maximum} characters.`);
  }
  return normalizeSearchTerm(value);
}

function optionalEnum(value, field, allowed) {
  if (value === undefined) return "";
  if (!allowed.includes(value)) {
    throw new MarketplaceMcpError("invalid-arguments", `${field} must use a supported marketplace value.`);
  }
  return value;
}

function optionalTags(value) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.length > maximumSubmissionTags
    || new Set(value).size !== value.length
    || value.some((tag) => !allowedTags.includes(tag))
  ) {
    throw new MarketplaceMcpError("invalid-arguments", "tags must contain up to three unique marketplace tags.");
  }
  return value;
}

function boundedLimit(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 25) {
    throw new MarketplaceMcpError("invalid-arguments", "limit must be an integer from 1 through 25.");
  }
  return value;
}

function textResult(data, summary = "") {
  return {
    content: [{
      type: "text",
      text: summary || JSON.stringify(data, null, 2),
    }],
    structuredContent: data,
    isError: false,
  };
}

function pluginSearchText(plugin) {
  return [
    plugin.name,
    plugin.id,
    plugin.description,
    plugin.author,
    plugin.category,
    plugin.kind,
    ...(plugin.tags || []),
  ].filter(Boolean).join(" ");
}

function searchRank(plugin, query) {
  const requested = foldSearchTerm(query);
  const name = foldSearchTerm(plugin.name);
  const id = foldSearchTerm(plugin.id);
  if (!requested) return 10;
  if (requested === id) return 0;
  if (requested === name) return 1;
  if (id.startsWith(requested)) return 2;
  if (name.startsWith(requested)) return 3;
  if (id.includes(requested) || name.includes(requested)) return 4;
  return 5;
}

function titleConsistency(title, manifestName) {
  if (!title) return { status: "not-provided", submitted: null, manifest: manifestName || null };
  const submitted = title.startsWith(submissionTitlePrefix)
    ? title.slice(submissionTitlePrefix.length).trim()
    : title.trim();
  return {
    status: foldSearchTerm(submitted) === foldSearchTerm(manifestName) ? "matches" : "differs",
    submitted,
    manifest: manifestName || null,
  };
}

function validateSimilarityCandidate(args) {
  const candidate = {
    repository: optionalString(args.repository, "repository", 300),
    repositoryNodeId: optionalString(args.repositoryNodeId, "repositoryNodeId", 200),
    repositoryDatabaseId: args.repositoryDatabaseId,
    id: optionalString(args.id, "id", 128),
    name: optionalString(args.name, "name", 120),
    description: optionalString(args.description, "description", 500),
    author: optionalString(args.author, "author", 120),
    category: optionalEnum(args.category, "category", allowedCategories),
    tags: optionalTags(args.tags),
    kind: optionalString(args.kind, "kind", 64),
  };
  if (candidate.id && !pluginIdPattern.test(candidate.id)) {
    throw new MarketplaceMcpError("invalid-arguments", "id is not a valid marketplace plugin ID.");
  }
  if (
    candidate.repositoryDatabaseId !== undefined
    && (!Number.isSafeInteger(candidate.repositoryDatabaseId) || candidate.repositoryDatabaseId < 1)
  ) {
    throw new MarketplaceMcpError("invalid-arguments", "repositoryDatabaseId must be a positive integer.");
  }
  if (!candidate.repository && !candidate.id && !candidate.name && !candidate.description) {
    throw new MarketplaceMcpError("invalid-arguments", "Provide a repository, plugin ID, name, or description.");
  }
  return candidate;
}

export function createMarketplaceService({ loadState, inspector, previewProvider }) {
  if (typeof loadState !== "function" || !inspector || !previewProvider) {
    throw new MarketplaceMcpError("configuration-invalid", "Marketplace MCP service adapters are incomplete.");
  }

  async function searchPlugins(value) {
    const args = objectArguments(value, [
      "query", "category", "tags", "kind", "verificationStatus", "installAvailable", "limit",
    ]);
    const query = args.query === undefined ? "" : optionalString(args.query, "query", 160);
    const category = optionalEnum(args.category, "category", allowedCategories);
    const tags = optionalTags(args.tags);
    const kind = optionalString(args.kind, "kind", 64);
    const verificationStatus = optionalEnum(
      args.verificationStatus,
      "verificationStatus",
      ["verified", "unverified"],
    );
    if (args.installAvailable !== undefined && typeof args.installAvailable !== "boolean") {
      throw new MarketplaceMcpError("invalid-arguments", "installAvailable must be a boolean.");
    }
    const limit = boundedLimit(args.limit, 10);
    const state = await loadState();
    const matches = state.plugins.filter((plugin) => (
      (!query || matchesDirectSearch(query, {
        publisher: plugin.author,
        primaryText: `${plugin.name} ${plugin.id}`,
        searchText: pluginSearchText(plugin),
      }))
      && (!category || plugin.category === category)
      && (!tags.length || tags.every((tag) => (plugin.tags || []).includes(tag)))
      && (!kind || foldSearchTerm(plugin.kind) === foldSearchTerm(kind))
      && (!verificationStatus || plugin.verificationStatus === verificationStatus)
      && (args.installAvailable === undefined || Boolean(plugin.installAvailable) === args.installAvailable)
    ));
    const results = matches
      .sort((left, right) => (
        searchRank(left, query) - searchRank(right, query)
        || Number(right.verificationStatus === "verified") - Number(left.verificationStatus === "verified")
        || (right.stars || 0) - (left.stars || 0)
        || left.name.localeCompare(right.name)
        || left.id.localeCompare(right.id)
      ))
      .slice(0, limit)
      .map(compactPlugin);
    return textResult({
      query,
      filters: {
        category: category || null,
        tags,
        kind: kind || null,
        verificationStatus: verificationStatus || null,
        installAvailable: args.installAvailable ?? null,
      },
      totalMatches: matches.length,
      returned: results.length,
      catalogGeneratedAt: state.catalog.generatedAt || null,
      results,
    });
  }

  async function getPlugin(value) {
    const args = objectArguments(value, ["pluginId"]);
    const pluginId = optionalString(args.pluginId, "pluginId", 128, { required: true });
    if (!pluginIdPattern.test(pluginId)) {
      throw new MarketplaceMcpError("invalid-arguments", "pluginId is not a valid marketplace plugin ID.");
    }
    const state = await loadState();
    const plugin = pluginById(state, pluginId);
    if (!plugin) throw new MarketplaceMcpError("plugin-not-found", `Plugin "${pluginId}" is not listed.`);
    return textResult(detailedPlugin(plugin));
  }

  async function findSimilarPlugins(value) {
    const args = objectArguments(value, [
      "repository", "repositoryNodeId", "repositoryDatabaseId", "id", "name", "description",
      "author", "category", "tags", "kind", "limit",
    ]);
    const state = await loadState();
    const result = analyzeDuplicates(state, validateSimilarityCandidate(args), {
      limit: boundedLimit(args.limit, 8),
    });
    return textResult(result);
  }

  async function reviewCandidate(value) {
    const args = objectArguments(value, [
      "repository", "commit", "submissionTitle", "category", "tags", "similarityLimit",
    ]);
    const repository = optionalString(args.repository, "repository", 300, { required: true });
    const commit = optionalString(args.commit, "commit", 40);
    if (commit && !fullCommitPattern.test(commit)) {
      throw new MarketplaceMcpError("invalid-arguments", "commit must be a full 40-character SHA.");
    }
    const submissionTitle = optionalString(args.submissionTitle, "submissionTitle", 160);
    const category = optionalEnum(args.category, "category", allowedCategories);
    const tags = optionalTags(args.tags);
    const inspection = await inspector.inspect({ repository, commit });
    const state = await loadState();
    const manifest = inspection.manifest;
    const candidate = {
      repository: inspection.repository.url,
      repositoryNodeId: inspection.repository.nodeId,
      repositoryDatabaseId: inspection.repository.databaseId,
      id: manifest?.id || "",
      name: manifest?.name || submissionTitle.replace(/^\[Plugin\]:\s*/i, ""),
      description: manifest?.description || inspection.repository.description,
      author: manifest?.author || "",
      category: category || inspection.suggestedTaxonomy.category,
      tags: tags.length ? tags : inspection.suggestedTaxonomy.tags,
      kind: manifest?.kinds?.join(" ") || "",
    };
    const duplicates = analyzeDuplicates(state, candidate, {
      limit: boundedLimit(args.similarityLimit, 8),
    });
    const metadataConsistency = {
      title: titleConsistency(submissionTitle, manifest?.name || ""),
      description: {
        manifest: manifest?.description || null,
        repository: inspection.repository.description || null,
        sameNormalizedText: Boolean(
          manifest?.description
          && inspection.repository.description
          && foldSearchTerm(manifest.description) === foldSearchTerm(inspection.repository.description)
        ),
      },
      taxonomy: {
        submittedCategory: category || null,
        submittedTags: tags,
        suggested: inspection.suggestedTaxonomy,
        categorySupported: !category || allowedCategories.includes(category),
        tagsSupported: tags.every((tag) => allowedTags.includes(tag)),
      },
    };
    const report = {
      ...inspection,
      metadataConsistency,
      duplicateAnalysis: duplicates,
      submissionReadiness: {
        status: inspection.checks.status === "needs-fixes" || duplicates.exactConflicts.length
          ? "needs-fixes"
          : duplicates.conclusion === "manual-comparison-required"
            || inspection.checks.status === "review-required"
            || metadataConsistency.title.status === "differs"
            ? "review-required"
            : "ready-for-owner-confirmation",
        ownerConfirmationRequired: submissionChecklist,
        note: "An agent must show the completed submission to the owner and receive explicit approval before creating an issue.",
      },
    };
    return textResult(report);
  }

  async function getPreview(value) {
    const args = objectArguments(value, ["pluginId", "repository", "commit"]);
    const pluginId = optionalString(args.pluginId, "pluginId", 128);
    const repository = optionalString(args.repository, "repository", 300);
    const commit = optionalString(args.commit, "commit", 40);
    if (pluginId && (repository || commit)) {
      throw new MarketplaceMcpError("invalid-arguments", "Use either pluginId or repository with commit, not both.");
    }
    let preview;
    if (pluginId) {
      if (!pluginIdPattern.test(pluginId)) {
        throw new MarketplaceMcpError("invalid-arguments", "pluginId is not a valid marketplace plugin ID.");
      }
      const state = await loadState();
      const plugin = pluginById(state, pluginId);
      if (!plugin) throw new MarketplaceMcpError("plugin-not-found", `Plugin "${pluginId}" is not listed.`);
      preview = await previewProvider.listed(plugin);
    } else {
      if (!repository || !fullCommitPattern.test(commit)) {
        throw new MarketplaceMcpError(
          "invalid-arguments",
          "Candidate previews require repository and a full 40-character commit SHA.",
        );
      }
      preview = await previewProvider.candidate({ repository, commit });
    }
    return {
      content: [
        { type: "text", text: JSON.stringify(preview.metadata, null, 2) },
        { type: "image", data: preview.data, mimeType: preview.mimeType },
      ],
      structuredContent: preview.metadata,
      isError: false,
    };
  }

  const handlers = Object.freeze({
    search_plugins: searchPlugins,
    get_plugin: getPlugin,
    find_similar_plugins: findSimilarPlugins,
    review_candidate: reviewCandidate,
    get_preview: getPreview,
  });

  return Object.freeze({
    async callTool(name, args = {}) {
      const handler = handlers[name];
      if (!handler) throw new MarketplaceMcpError("tool-not-found", `Unknown marketplace tool "${name}".`);
      return handler(args);
    },

    async listResources() {
      return [
        {
          uri: "marketplace://catalog/summary",
          name: "Marketplace catalog summary",
          description: "Current catalog size, generation time, warnings, and taxonomy.",
          mimeType: "application/json",
        },
        {
          uri: "marketplace://submission/policy",
          name: "Plugin submission policy",
          description: "Agent-facing submission values, checklist, and trust boundary.",
          mimeType: "application/json",
        },
      ];
    },

    async listResourceTemplates() {
      return [
        {
          uriTemplate: "marketplace://plugins/{pluginId}",
          name: "Marketplace plugin record",
          description: "Complete public catalog record for an exact plugin ID.",
          mimeType: "application/json",
        },
        {
          uriTemplate: "marketplace://plugins/{pluginId}/preview",
          name: "Marketplace plugin preview",
          description: "Optimized preview image for an exact plugin ID.",
          mimeType: "image/webp",
        },
      ];
    },

    async readResource(uri) {
      if (uri === "marketplace://catalog/summary") {
        const state = await loadState();
        const data = {
          generatedAt: state.catalog.generatedAt || null,
          pluginCount: state.plugins.length,
          sourceCount: state.registry.sources.length,
          retiredPluginIdCount: state.retiredPluginIds.size,
          warnings: state.catalog.warnings || [],
          categories: allowedCategories,
          tags: allowedTags,
        };
        return [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }];
      }
      if (uri === "marketplace://submission/policy") {
        const data = {
          titlePrefix: submissionTitlePrefix,
          categories: allowedCategories,
          tags: allowedTags,
          maximumTags: maximumSubmissionTags,
          checklist: submissionChecklist,
          disclaimer: "Marketplace validation and MCP inspection are not a security review, certification, warranty, or endorsement.",
        };
        return [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }];
      }
      const match = uri.match(/^marketplace:\/\/plugins\/([^/]+)(\/preview)?$/);
      if (!match) throw new MarketplaceMcpError("resource-not-found", `Unknown marketplace resource "${uri}".`);
      let pluginId;
      try {
        pluginId = decodeURIComponent(match[1]);
      } catch {
        throw new MarketplaceMcpError("resource-not-found", "Marketplace resource contains an invalid plugin ID.");
      }
      if (!pluginIdPattern.test(pluginId)) {
        throw new MarketplaceMcpError("resource-not-found", "Marketplace resource contains an invalid plugin ID.");
      }
      const state = await loadState();
      const plugin = pluginById(state, pluginId);
      if (!plugin) throw new MarketplaceMcpError("plugin-not-found", `Plugin "${pluginId}" is not listed.`);
      if (match[2]) {
        const preview = await previewProvider.listed(plugin);
        return [{ uri, mimeType: preview.mimeType, blob: preview.data }];
      }
      return [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(detailedPlugin(plugin), null, 2),
      }];
    },
  });
}
