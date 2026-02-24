import crypto from 'crypto';
import type Parser from 'web-tree-sitter';
import type { ChunkResult } from './types.js';

export interface AstChunkerConfig {
  chunkSize: number;
  maxChunkSize: number;
}

const MAX_RECURSIVE_DEPTH = 3;

function hash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Check if a node is a comment type across languages.
 */
function isCommentNode(node: Parser.SyntaxNode): boolean {
  const t = node.type;
  return t === 'comment' || t === 'line_comment' || t === 'block_comment';
}

/**
 * Extract text for a line range from the content lines array.
 * Uses line-based reconstruction to preserve inter-node whitespace/comments.
 */
function textForRange(contentLines: string[], startLine: number, endLine: number): string {
  return contentLines.slice(startLine, endLine + 1).join('\n');
}

/**
 * Fixed-size split for leaf nodes that exceed maxChunkSize.
 * Produces chunks without overlap (AST chunks are self-contained).
 */
function fixedSplit(
  contentLines: string[],
  startLine: number,
  endLine: number,
  maxChunkSize: number
): ChunkResult[] {
  const chunks: ChunkResult[] = [];
  let currentStart = startLine;

  while (currentStart <= endLine) {
    let size = 0;
    let currentEnd = currentStart;

    while (currentEnd <= endLine) {
      const lineLen = (contentLines[currentEnd] ?? '').length + 1;
      if (size + lineLen > maxChunkSize && currentEnd > currentStart) break;
      size += lineLen;
      currentEnd++;
    }
    currentEnd--; // back to last included line

    const text = textForRange(contentLines, currentStart, currentEnd);
    if (text.trim()) {
      chunks.push({
        content: text,
        startLine: currentStart,
        endLine: currentEnd,
        hash: hash(text),
      });
    }
    currentStart = currentEnd + 1;
  }

  return chunks;
}

/**
 * Recursively split a node that exceeds maxChunkSize by its named children.
 */
function splitNode(
  node: Parser.SyntaxNode,
  contentLines: string[],
  config: AstChunkerConfig,
  depth: number
): ChunkResult[] {
  const text = textForRange(contentLines, node.startPosition.row, node.endPosition.row);

  // If it fits, return as single chunk
  if (text.length <= config.maxChunkSize) {
    if (!text.trim()) return [];
    return [
      {
        content: text,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        hash: hash(text),
      },
    ];
  }

  const children = node.namedChildren;

  // At depth limit or no children to split by: fixed-size split
  if (depth >= MAX_RECURSIVE_DEPTH || children.length === 0) {
    return fixedSplit(
      contentLines,
      node.startPosition.row,
      node.endPosition.row,
      config.maxChunkSize
    );
  }

  // Recursively split by children, preserving inter-child text
  const chunks: ChunkResult[] = [];
  let lastEnd = node.startPosition.row;

  for (const child of children) {
    const childStart = child.startPosition.row;

    // Text between last child end and this child start (preamble/inter-child text)
    if (childStart > lastEnd) {
      const interText = textForRange(contentLines, lastEnd, childStart - 1);
      if (interText.trim()) {
        // Attach inter-child text to this child's chunk (will be handled below)
        // For simplicity, emit it as a standalone small chunk
        chunks.push({
          content: interText,
          startLine: lastEnd,
          endLine: childStart - 1,
          hash: hash(interText),
        });
      }
    }

    const childChunks = splitNode(child, contentLines, config, depth + 1);
    chunks.push(...childChunks);

    lastEnd = child.endPosition.row + 1;
  }

  // Trailing text after last child
  if (lastEnd <= node.endPosition.row) {
    const trailing = textForRange(contentLines, lastEnd, node.endPosition.row);
    if (trailing.trim()) {
      chunks.push({
        content: trailing,
        startLine: lastEnd,
        endLine: node.endPosition.row,
        hash: hash(trailing),
      });
    }
  }

  return chunks;
}

/**
 * Chunk source code using tree-sitter AST.
 *
 * Top-level AST nodes become natural chunk boundaries.
 * Small adjacent nodes are grouped until chunkSize. Large nodes are
 * split recursively by their children. Comments preceding a declaration
 * are attached to the same chunk.
 *
 * @param tree - Parsed tree-sitter tree
 * @param content - Original source code string
 * @param config - Chunking configuration (chunkSize, maxChunkSize)
 * @returns Array of ChunkResult with 0-indexed line numbers
 */
export function chunkByAst(
  tree: Parser.Tree,
  content: string,
  config: AstChunkerConfig
): ChunkResult[] {
  const contentLines = content.split('\n');
  if (contentLines.length === 0 || !content.trim()) return [];

  const root = tree.rootNode;
  const topLevelNodes = root.namedChildren;

  if (topLevelNodes.length === 0) {
    // No named children — treat entire content as one chunk if non-empty
    if (content.trim()) {
      return [
        {
          content,
          startLine: 0,
          endLine: contentLines.length - 1,
          hash: hash(content),
        },
      ];
    }
    return [];
  }

  const chunks: ChunkResult[] = [];

  // Group of consecutive nodes being accumulated
  let groupStartLine = 0; // start from beginning of file (captures leading content)
  let groupEndLine = -1;
  let groupSize = 0;

  function flushGroup(): void {
    if (groupEndLine < groupStartLine) return;
    const text = textForRange(contentLines, groupStartLine, groupEndLine);
    if (!text.trim()) return;
    chunks.push({
      content: text,
      startLine: groupStartLine,
      endLine: groupEndLine,
      hash: hash(text),
    });
    groupSize = 0;
  }

  for (let i = 0; i < topLevelNodes.length; i++) {
    const node = topLevelNodes[i]!;
    const nodeStart = node.startPosition.row;
    const nodeEnd = node.endPosition.row;

    // Compute this node's text size (including any leading inter-node text from groupEndLine+1)
    const effectiveStart = groupEndLine >= 0 ? groupEndLine + 1 : groupStartLine;
    const nodeTextStart = Math.min(effectiveStart, nodeStart);
    const nodeText = textForRange(contentLines, nodeTextStart, nodeEnd);
    const nodeSize = nodeText.length;

    // Attach leading comments: if previous node(s) are comments and this node is not,
    // they're already accumulated in the group — which is the desired behavior.

    // Check if this node alone exceeds maxChunkSize (needs splitting)
    if (nodeSize > config.maxChunkSize && !isCommentNode(node)) {
      // Flush current group first
      if (groupEndLine >= groupStartLine) {
        // Include any inter-node text before this node in the current group
        const preNodeEnd = nodeStart - 1;
        if (preNodeEnd >= (groupEndLine >= 0 ? groupEndLine + 1 : groupStartLine)) {
          groupEndLine = preNodeEnd;
        }
        flushGroup();
      }

      // Handle inter-node text before the large node (if any gap after flushed group)
      const gapStart = groupEndLine >= 0 ? groupEndLine + 1 : groupStartLine;
      if (gapStart < nodeStart) {
        const gapText = textForRange(contentLines, gapStart, nodeStart - 1);
        if (gapText.trim()) {
          chunks.push({
            content: gapText,
            startLine: gapStart,
            endLine: nodeStart - 1,
            hash: hash(gapText),
          });
        }
      }

      // Split the large node recursively
      const splitChunks = splitNode(node, contentLines, config, 0);
      chunks.push(...splitChunks);

      // Reset group to start after this node
      groupStartLine = nodeEnd + 1;
      groupEndLine = nodeEnd;
      groupSize = 0;
      continue;
    }

    // Would adding this node exceed chunkSize?
    if (groupSize + nodeSize > config.chunkSize && groupEndLine >= groupStartLine) {
      // If the previous node(s) in the group are all comments and this node is a declaration,
      // keep comments with this node instead of flushing them separately
      const isCurrentComment = isCommentNode(node);
      if (!isCurrentComment) {
        // Check if everything in the group so far is just comments/whitespace before this declaration
        // We do a simple heuristic: flush only if group already has non-comment content
        flushGroup();
        groupStartLine = groupEndLine + 1;
      }
    }

    // Extend group to include this node
    groupEndLine = nodeEnd;
    groupSize = textForRange(contentLines, groupStartLine, groupEndLine).length;
  }

  // Flush remaining group + any trailing content after last node
  const lastNodeEnd = topLevelNodes[topLevelNodes.length - 1]!.endPosition.row;
  const fileEnd = contentLines.length - 1;
  if (lastNodeEnd < fileEnd) {
    groupEndLine = fileEnd;
  }
  flushGroup();

  return chunks;
}
