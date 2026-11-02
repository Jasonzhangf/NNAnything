import com.sun.source.tree.AnnotatedTypeTree;
import com.sun.source.tree.ArrayTypeTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.LineMap;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.ModifiersTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;

import javax.lang.model.element.Modifier;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.ToolProvider;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Parse-only Java declaration extractor built solely on the public
 * {@code javax.tools} and {@code com.sun.source} APIs. One JVM batch reads the
 * repository root and an argument file that lists repository-relative `.java`
 * paths, parses each file independently, and writes one NDJSON line per file
 * plus a final summary line. No semantic analysis is performed.
 */
public final class ExtractJavaSymbols {

    private ExtractJavaSymbols() {
    }

    // ------------------------------------------------------------------
    // JSON helpers
    // ------------------------------------------------------------------

    static String escape(String value) {
        if (value == null) {
            return "";
        }
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\':
                    out.append("\\\\");
                    break;
                case '"':
                    out.append("\\\"");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.toString();
    }

    static String jsonString(String value) {
        return value == null ? "null" : ("\"" + escape(value) + "\"");
    }

    static String jsonStringList(List<String> values) {
        StringBuilder out = new StringBuilder("[");
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) {
                out.append(',');
            }
            out.append(jsonString(values.get(i)));
        }
        out.append(']');
        return out.toString();
    }

    // ------------------------------------------------------------------
    // Code-point column math (1-based)
    // ------------------------------------------------------------------

    static int codePointColumn(String text, int lineStart, int offset) {
        int safeOffset = Math.max(lineStart, Math.min(text.length(), offset));
        int column = 0;
        int index = lineStart;
        while (index < safeOffset) {
            int codePoint = text.codePointAt(index);
            index += Character.charCount(codePoint);
            column += 1;
        }
        return column + 1;
    }

    static String spanJson(LineMap lineMap, String text, int start, int end) {
        int startLine = (int) lineMap.getLineNumber(start);
        int endLine = (int) lineMap.getLineNumber(end);
        int startLineStart = (int) lineMap.getStartPosition(startLine);
        int endLineStart = (int) lineMap.getStartPosition(endLine);
        int startCol = codePointColumn(text, startLineStart, start);
        int endCol = codePointColumn(text, endLineStart, end);
        return "{\"startLine\":" + startLine
                + ",\"startCol\":" + startCol
                + ",\"endLine\":" + endLine
                + ",\"endCol\":" + endCol + "}";
    }

    static String spanKey(LineMap lineMap, String text, int start, int end) {
        int startLine = (int) lineMap.getLineNumber(start);
        int endLine = (int) lineMap.getLineNumber(end);
        int startCol = codePointColumn(text, (int) lineMap.getStartPosition(startLine), start);
        int endCol = codePointColumn(text, (int) lineMap.getStartPosition(endLine), end);
        return startLine + ":" + startCol + "-" + endLine + ":" + endCol;
    }

    // ------------------------------------------------------------------
    // Lightweight Java header lexical scanner
    // ------------------------------------------------------------------

    static final class Token {
        final int start;
        final int end;

        Token(int start, int end) {
            this.start = start;
            this.end = end;
        }
    }

    static int skipWsAndComments(String s, int p, int limit) {
        while (true) {
            if (p >= limit) {
                return p;
            }
            char c = s.charAt(p);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f') {
                p++;
                continue;
            }
            if (c == '/' && p + 1 < limit) {
                char n = s.charAt(p + 1);
                if (n == '/') {
                    p += 2;
                    while (p < limit && s.charAt(p) != '\n') {
                        p++;
                    }
                    continue;
                }
                if (n == '*') {
                    p += 2;
                    while (p + 1 < limit && !(s.charAt(p) == '*' && s.charAt(p + 1) == '/')) {
                        p++;
                    }
                    p = (p + 1 < limit) ? p + 2 : limit;
                    continue;
                }
            }
            return p;
        }
    }

    static int skipStringLike(String s, int p, int limit, char quote) {
        p++;
        while (p < limit) {
            char c = s.charAt(p);
            if (c == '\\') {
                p += 2;
                continue;
            }
            if (c == quote) {
                return p + 1;
            }
            p++;
        }
        return limit;
    }

    static int skipBalanced(String s, int p, int limit, char open, char close) {
        int depth = 0;
        while (p < limit) {
            char c = s.charAt(p);
            if (c == open) {
                depth++;
                p++;
            } else if (c == close) {
                depth--;
                p++;
                if (depth == 0) {
                    return p;
                }
            } else if (c == '"' || c == '\'') {
                p = skipStringLike(s, p, limit, c);
            } else if (c == '/' && p + 1 < limit && s.charAt(p + 1) == '*') {
                p += 2;
                while (p + 1 < limit && !(s.charAt(p) == '*' && s.charAt(p + 1) == '/')) {
                    p++;
                }
                p = (p + 1 < limit) ? p + 2 : limit;
            } else {
                p++;
            }
        }
        return limit;
    }

    static Token readIdentifier(String s, int p, int limit) {
        if (p < 0 || p >= limit) {
            return null;
        }
        int codePoint = s.codePointAt(p);
        if (!Character.isJavaIdentifierStart(codePoint)) {
            return null;
        }
        int index = p + Character.charCount(codePoint);
        while (index < limit) {
            int c = s.codePointAt(index);
            if (!Character.isJavaIdentifierPart(c)) {
                break;
            }
            index += Character.charCount(c);
        }
        return new Token(p, index);
    }

    static int skipTriviaAndAnnotations(String s, int p, int limit) {
        int cursor = p;
        while (true) {
            int resume = skipWsAndComments(s, cursor, limit);
            if (resume > cursor) {
                cursor = resume;
            }
            if (cursor >= limit || s.charAt(cursor) != '@') {
                return cursor;
            }
            int afterAt = skipWsAndComments(s, cursor + 1, limit);
            Token first = readIdentifier(s, afterAt, limit);
            if (first == null) {
                return cursor;
            }
            if ("interface".equals(s.substring(first.start, first.end))) {
                // @interface is the annotation-declaration keyword, not an annotation.
                return cursor;
            }
            int tail = first.end;
            while (true) {
                int dot = skipWsAndComments(s, tail, limit);
                if (dot < limit && s.charAt(dot) == '.') {
                    Token next = readIdentifier(s, skipWsAndComments(s, dot + 1, limit), limit);
                    if (next == null) {
                        tail = dot + 1;
                        break;
                    }
                    tail = next.end;
                } else {
                    tail = dot;
                    break;
                }
            }
            int args = skipWsAndComments(s, tail, limit);
            if (args < limit && s.charAt(args) == '(') {
                tail = skipBalanced(s, args, limit, '(', ')');
            }
            cursor = tail;
        }
    }

    static int skipPrefixBracketsAndAnnotations(String s, int p, int limit) {
        if (p < 0) {
            return p;
        }
        int cursor = skipTriviaAndAnnotations(s, p, limit);
        while (cursor < limit && s.charAt(cursor) == '[') {
            cursor = skipBalanced(s, cursor, limit, '[', ']');
            cursor = skipTriviaAndAnnotations(s, cursor, limit);
        }
        return cursor;
    }

    static int skipCommaAndTrivia(String s, int p, int limit) {
        int cursor = skipWsAndComments(s, p, limit);
        if (cursor < limit && s.charAt(cursor) == ',') {
            cursor++;
        }
        return skipTriviaAndAnnotations(s, cursor, limit);
    }

    static int unwrapBaseTypeEndPos(SourcePositions sp, CompilationUnitTree cu, Tree type) {
        Tree cur = type;
        while (cur != null) {
            Tree next = null;
            if (cur instanceof ArrayTypeTree) {
                next = ((ArrayTypeTree) cur).getType();
            } else if (cur instanceof AnnotatedTypeTree) {
                next = ((AnnotatedTypeTree) cur).getUnderlyingType();
            }
            if (next == null) {
                break;
            }
            cur = next;
        }
        return cur == null ? -1 : (int) sp.getEndPosition(cu, cur);
    }

    /**
     * Locates the declared name token for a type declaration header. Returns
     * null when the raw token could not be confirmed to equal the AST name.
     */
    static int[] typeDeclNameToken(CompilationUnitTree cu, SourcePositions sp, String text, ClassTree ct) {
        int limit = (int) sp.getEndPosition(cu, ct);
        if (limit < 0) {
            limit = text.length();
        }
        long modEnd = ct.getModifiers() == null ? -1 : sp.getEndPosition(cu, ct.getModifiers());
        int start = modEnd >= 0 ? (int) modEnd : (int) sp.getStartPosition(cu, ct);
        if (start < 0 || start >= limit) {
            return null;
        }
        int p = skipTriviaAndAnnotations(text, start, limit);
        if (p < limit && text.charAt(p) == '@') {
            p++;
            p = skipWsAndComments(text, p, limit);
        }
        Token keyword = readIdentifier(text, p, limit);
        if (keyword != null) {
            p = skipTriviaAndAnnotations(text, keyword.end, limit);
        }
        Token name = readIdentifier(text, p, limit);
        return name == null ? null : new int[] {name.start, name.end};
    }

    /** Locates the return-type method name token using the public AST anchors. */
    static int[] methodNameToken(CompilationUnitTree cu, SourcePositions sp, String text, MethodTree mt) {
        int mtEnd = (int) sp.getEndPosition(cu, mt);
        if (mtEnd < 0) {
            return null;
        }
        int baseRetEnd = unwrapBaseTypeEndPos(sp, cu, mt.getReturnType());
        int searchStart = skipPrefixBracketsAndAnnotations(text, baseRetEnd, mtEnd);
        int searchEnd;
        if (!mt.getParameters().isEmpty()) {
            searchEnd = (int) sp.getStartPosition(cu, mt.getParameters().get(0));
        } else if (mt.getBody() != null) {
            searchEnd = (int) sp.getStartPosition(cu, mt.getBody());
        } else {
            searchEnd = mtEnd;
        }
        if (searchStart < 0 || searchEnd < 0 || searchEnd > mtEnd) {
            searchEnd = mtEnd;
        }
        Token token = readIdentifier(text, searchStart, searchEnd);
        return token == null ? null : new int[] {token.start, token.end};
    }

    /** Locates an explicit constructor or record compact constructor name token. */
    static int[] constructorNameToken(CompilationUnitTree cu, SourcePositions sp, String text, MethodTree mt,
                                      String enclosingSimpleName) {
        int mtStart = (int) sp.getStartPosition(cu, mt);
        int mtEnd = (int) sp.getEndPosition(cu, mt);
        if (mtStart < 0 || mtEnd < 0) {
            return null;
        }
        int searchStart;
        if (!mt.getTypeParameters().isEmpty()) {
            Tree last = mt.getTypeParameters().get(mt.getTypeParameters().size() - 1);
            int lastEnd = (int) sp.getEndPosition(cu, last);
            if (lastEnd < 0) {
                return null;
            }
            int p = skipWsAndComments(text, lastEnd, mtEnd);
            while (p < mtEnd && text.charAt(p) != '>') {
                p++;
            }
            if (p >= mtEnd) {
                return null;
            }
            searchStart = skipTriviaAndAnnotations(text, p + 1, mtEnd);
        } else {
            long modEnd = mt.getModifiers() == null ? -1 : sp.getEndPosition(cu, mt.getModifiers());
            searchStart = modEnd >= 0 ? (int) modEnd : mtStart;
        }
        int searchEnd;
        if (!mt.getParameters().isEmpty() && (int) sp.getStartPosition(cu, mt.getParameters().get(0)) >= mtStart) {
            searchEnd = (int) sp.getStartPosition(cu, mt.getParameters().get(0));
        } else if (mt.getBody() != null && (int) sp.getStartPosition(cu, mt.getBody()) >= mtStart) {
            searchEnd = (int) sp.getStartPosition(cu, mt.getBody());
        } else {
            searchEnd = mtEnd;
        }
        int p = skipTriviaAndAnnotations(text, searchStart, searchEnd);
        Token token = readIdentifier(text, p, searchEnd);
        if (token == null) {
            return null;
        }
        if (!enclosingSimpleName.equals(text.substring(token.start, token.end))) {
            return null;
        }
        return new int[] {token.start, token.end};
    }

    /** True when a VariableTree in an enum body is a source enum constant. */
    static boolean isEnumConstantByScanner(CompilationUnitTree cu, SourcePositions sp, String text, VariableTree vt,
                                           int varStart, int varEnd) {
        if (varStart < 0 || varEnd <= varStart) {
            return false;
        }
        long modEnd = vt.getModifiers() == null ? -1 : sp.getEndPosition(cu, vt.getModifiers());
        int start = modEnd >= 0 && modEnd > varStart ? (int) modEnd : varStart;
        int p = skipTriviaAndAnnotations(text, start, varEnd);
        Token first = readIdentifier(text, p, varEnd);
        if (first == null) {
            return false;
        }
        String name = vt.getName().toString();
        if (!name.equals(text.substring(first.start, first.end))) {
            return false;
        }
        int after = skipTriviaAndAnnotations(text, first.end, varEnd);
        if (after >= varEnd) {
            return true;
        }
        char c = text.charAt(after);
        // JLS enum constants never use '='; accepting it here would let a
        // corrupted field whose type token was lost masquerade as a constant.
        return c == '(' || c == '{' || c == ',' || c == ';';
    }

    static int[] variableNameToken(CompilationUnitTree cu, SourcePositions sp, String text, VariableTree vt,
                                   int searchStart, int varEnd) {
        if (searchStart < 0 || varEnd <= searchStart) {
            return null;
        }
        int p = skipPrefixBracketsAndAnnotations(text, searchStart, varEnd);
        Token token = readIdentifier(text, p, varEnd);
        return token == null ? null : new int[] {token.start, token.end};
    }

    // ------------------------------------------------------------------
    // AST mapping helpers
    // ------------------------------------------------------------------

    static String typeKind(ClassTree ct) {
        switch (ct.getKind()) {
            case CLASS:
                return "class";
            case INTERFACE:
                return "interface";
            case ENUM:
                return "enum";
            case RECORD:
                return "record";
            case ANNOTATION_TYPE:
                return "annotation_interface";
            default:
                return "class";
        }
    }

    static String ownerKindLabel(ClassTree ct) {
        return typeKind(ct);
    }

    static String scopePrefix(ClassTree ct) {
        switch (ct.getKind()) {
            case INTERFACE:
                return "interface";
            case ENUM:
                return "enum";
            case RECORD:
                return "record";
            case ANNOTATION_TYPE:
                return "@interface";
            case CLASS:
            default:
                return "class";
        }
    }

    static String bodyDeclaredIn(ClassTree ct, TreePath classPath) {
        boolean anonymous = ct.getSimpleName().isEmpty()
                && classPath.getParentPath() != null
                && classPath.getParentPath().getLeaf() instanceof NewClassTree;
        if (anonymous) {
            return "anonymous_class_body";
        }
        switch (ct.getKind()) {
            case INTERFACE:
                return "interface_body";
            case ENUM:
                return "enum_body";
            case RECORD:
                return "record_body";
            case ANNOTATION_TYPE:
                return "annotation_body";
            case CLASS:
            default:
                return "class_body";
        }
    }

    static String simpleNameOfTree(Tree tree) {
        if (tree instanceof IdentifierTree) {
            return ((IdentifierTree) tree).getName().toString();
        }
        if (tree instanceof MemberSelectTree) {
            return ((MemberSelectTree) tree).getIdentifier().toString();
        }
        String rendered = tree == null ? "" : tree.toString();
        int dot = rendered.lastIndexOf('.');
        return dot >= 0 ? rendered.substring(dot + 1) : rendered;
    }

    static String declaringTypeName(ClassTree ct, TreePath classPath) {
        if (!ct.getSimpleName().isEmpty()) {
            return ct.getSimpleName().toString();
        }
        if (classPath.getParentPath() != null && classPath.getParentPath().getLeaf() instanceof NewClassTree) {
            NewClassTree nct = (NewClassTree) classPath.getParentPath().getLeaf();
            return "anon$" + simpleNameOfTree(nct.getIdentifier());
        }
        return "";
    }

    static String modifiersJson(ModifiersTree modifiers) {
        Set<String> flags = new LinkedHashSet<>();
        if (modifiers != null) {
            Set<Modifier> set = modifiers.getFlags();
            if (set.contains(Modifier.PUBLIC)) flags.add("public");
            if (set.contains(Modifier.PROTECTED)) flags.add("protected");
            if (set.contains(Modifier.PRIVATE)) flags.add("private");
            if (set.contains(Modifier.STATIC)) flags.add("static");
            if (set.contains(Modifier.FINAL)) flags.add("final");
            if (set.contains(Modifier.ABSTRACT)) flags.add("abstract");
            if (set.contains(Modifier.SYNCHRONIZED)) flags.add("synchronized");
            if (set.contains(Modifier.NATIVE)) flags.add("native");
            if (set.contains(Modifier.DEFAULT)) flags.add("default");
            if (set.contains(Modifier.STRICTFP)) flags.add("strictfp");
            if (set.contains(Modifier.SEALED)) flags.add("sealed");
            if (set.contains(Modifier.NON_SEALED)) flags.add("non-sealed");
        }
        return jsonStringList(new ArrayList<>(flags));
    }

    static String visibilityJson(ModifiersTree modifiers, String declaredIn, String kind) {
        if ("enum_constant".equals(kind)) {
            return "\"public\"";
        }
        if ("record_component".equals(kind)) {
            return "\"private\"";
        }
        if ("local_scope".equals(declaredIn)) {
            return "\"local\"";
        }
        Set<Modifier> set = modifiers == null ? Set.of() : modifiers.getFlags();
        if (set.contains(Modifier.PRIVATE)) return "\"private\"";
        if (set.contains(Modifier.PROTECTED)) return "\"protected\"";
        if (set.contains(Modifier.PUBLIC)) return "\"public\"";
        // Interface body members are implicitly public.
        if ("interface_body".equals(declaredIn) || "annotation_body".equals(declaredIn)) {
            return "\"public\"";
        }
        return "\"package_private\"";
    }

    // ------------------------------------------------------------------
    // Collector
    // ------------------------------------------------------------------

    static final class Collector extends TreePathScanner<Void, Void> {
        final CompilationUnitTree cu;
        final SourcePositions positions;
        final String text;
        final String relFile;
        final String packageName;
        final String fileParseStatus;
        final List<String> symbols = new ArrayList<>();
        final Map<ClassTree, int[]> memberState = new HashMap<>();
        final Map<ClassTree, int[]> layoutCache = new HashMap<>();
        int unconfirmedNameSpans;

        Collector(CompilationUnitTree cu, SourcePositions positions, String text, String relFile,
                  String packageName, String fileParseStatus) {
            this.cu = cu;
            this.positions = positions;
            this.text = text;
            this.relFile = relFile;
            this.packageName = packageName;
            this.fileParseStatus = fileParseStatus;
        }

        int spanStart(Tree tree) {
            return (int) positions.getStartPosition(cu, tree);
        }

        int spanEnd(Tree tree) {
            return (int) positions.getEndPosition(cu, tree);
        }

        /** [bodyOpenBrace, recordHeaderOpen, recordHeaderClose] */
        int[] layout(ClassTree ct) {
            int[] cached = layoutCache.get(ct);
            if (cached != null) {
                return cached;
            }
            int ctStart = spanStart(ct);
            int ctEnd = spanEnd(ct);
            int limit = ctEnd < 0 ? text.length() : ctEnd;
            int[] result = {-1, -1, -1};
            int[] nameToken = typeDeclNameToken(cu, positions, text, ct);
            int scanFrom = nameToken != null ? nameToken[1] : Math.max(ctStart, 0);
            int p = skipTriviaAndAnnotations(text, scanFrom, limit);
            // Skip type-parameter list so its angle brackets do not confuse us.
            if (p < limit && text.charAt(p) == '<') {
                p = skipBalanced(text, p, limit, '<', '>');
                p = skipTriviaAndAnnotations(text, p, limit);
            }
            if (ct.getKind() == Tree.Kind.RECORD) {
                int open = skipTriviaAndAnnotations(text, p, limit);
                // Account for "implements" clauses? The record header always follows the name.
                while (open < limit && text.charAt(open) != '(') {
                    open++;
                }
                if (open < limit) {
                    int close = skipBalanced(text, open, limit, '(', ')');
                    result[1] = open;
                    result[2] = close - 1;
                    p = close;
                }
            }
            int q = skipTriviaAndAnnotations(text, p, limit);
            int parenDepth = 0;
            while (q < limit) {
                char c = text.charAt(q);
                if (c == '(') {
                    parenDepth++;
                } else if (c == ')') {
                    if (parenDepth > 0) {
                        parenDepth--;
                    }
                } else if (c == '"' || c == '\'') {
                    q = skipStringLike(text, q, limit, c) - 1;
                } else if (c == '{' && parenDepth == 0) {
                    result[0] = q;
                    break;
                }
                q++;
            }
            layoutCache.put(ct, result);
            return result;
        }

        List<String> lexicalScope(TreePath path) {
            List<String> reversed = new ArrayList<>();
            TreePath current = path.getParentPath();
            while (current != null) {
                Tree leaf = current.getLeaf();
                if (leaf instanceof ClassTree) {
                    ClassTree ct = (ClassTree) leaf;
                    String name = declaringTypeName(ct, current);
                    if (!name.isEmpty()) {
                        reversed.add(scopePrefix(ct) + ":" + name);
                    }
                } else if (leaf instanceof MethodTree) {
                    MethodTree mt = (MethodTree) leaf;
                    if (mt.getReturnType() == null) {
                        reversed.add("constructor:" + constructorScopeName(mt, current));
                    } else {
                        reversed.add("method:" + mt.getName());
                    }
                }
                current = current.getParentPath();
            }
            List<String> scope = new ArrayList<>();
            if (packageName != null && !packageName.isEmpty()) {
                scope.add("pkg:" + packageName);
            }
            for (int i = reversed.size() - 1; i >= 0; i--) {
                scope.add(reversed.get(i));
            }
            return scope;
        }

        String constructorScopeName(MethodTree mt, TreePath methodPath) {
            TreePath parent = methodPath.getParentPath();
            if (parent != null && parent.getLeaf() instanceof ClassTree) {
                return declaringTypeName((ClassTree) parent.getLeaf(), parent);
            }
            return mt.getName().toString();
        }

        String ownerName(ClassTree owner, TreePath ownerPath) {
            String name = declaringTypeName(owner, ownerPath);
            return name.isEmpty() ? null : name;
        }

        void appendRecord(StringBuilder out, String name, String kind, String declaredIn, int declStart, int declEnd,
                          int[] nameToken, String nameSpanSource, ClassTree owner, TreePath ownerPath,
                          ModifiersTree modifiers, String visibilityOverride) {
            int safeDeclStart = declStart;
            int safeDeclEnd = declEnd;
            if (safeDeclStart < 0 || safeDeclEnd < 0) {
                safeDeclStart = Math.max(0, Math.min(text.length(), safeDeclStart));
                safeDeclEnd = safeDeclStart;
            }
            String declSpan = spanJson(cu.getLineMap(), text, safeDeclStart, safeDeclEnd);
            String symbolId = relFile + "#" + name + "@" + spanKey(cu.getLineMap(), text, safeDeclStart, safeDeclEnd);
            out.append("{\"symbolId\":").append(jsonString(symbolId))
                    .append(",\"name\":").append(jsonString(name))
                    .append(",\"kind\":").append(jsonString(kind))
                    .append(",\"file\":").append(jsonString(relFile))
                    .append(",\"declSpan\":").append(declSpan)
                    .append(",\"nameSpan\":");
            if (nameToken != null && nameToken[0] >= 0 && nameToken[1] > nameToken[0]) {
                out.append(spanJson(cu.getLineMap(), text, nameToken[0], nameToken[1]));
            } else {
                out.append("null");
                unconfirmedNameSpans++;
            }
            out.append(",\"nameSpanSource\":").append(jsonString(nameSpanSource))
                    .append(",\"packageName\":").append(jsonString(packageName))
                    .append(",\"lexicalScope\":").append(jsonStringList(lexicalScope(getCurrentPath())))
                    .append(",\"ownerType\":")
                    .append(owner == null ? "null" : jsonString(ownerName(owner, ownerPath)))
                    .append(",\"ownerKind\":")
                    .append(owner == null ? "null" : jsonString(ownerKindLabel(owner)))
                    .append(",\"modifiers\":").append(modifiersJson(modifiers))
                    .append(",\"visibility\":")
                    .append(visibilityOverride != null ? jsonString(visibilityOverride)
                            : visibilityJson(modifiers, declaredIn, kind))
                    .append(",\"declaredIn\":").append(jsonString(declaredIn))
                    .append(",\"parseStatus\":").append(jsonString(fileParseStatus))
                    .append("}");
            symbols.add(out.toString());
        }

        @Override
        public Void visitClass(ClassTree ct, Void unused) {
            TreePath path = getCurrentPath();
            TreePath parentPath = path.getParentPath();
            Tree parent = parentPath == null ? null : parentPath.getLeaf();
            boolean anonymous = ct.getSimpleName().isEmpty() && parent instanceof NewClassTree;
            String name;
            int[] nameToken;
            String nameSpanSource;
            int declStart = spanStart(ct);
            int declEnd = spanEnd(ct);
            if (anonymous) {
                NewClassTree nct = (NewClassTree) parent;
                name = "anon$" + simpleNameOfTree(nct.getIdentifier());
                int baseStart = spanStart(nct.getIdentifier());
                int baseEnd = spanEnd(nct.getIdentifier());
                if (baseStart >= 0 && baseEnd > baseStart) {
                    nameToken = new int[] {baseStart, baseEnd};
                    nameSpanSource = "anonymous_type";
                } else {
                    nameToken = null;
                    nameSpanSource = "unknown";
                }
            } else {
                name = ct.getSimpleName().toString();
                nameToken = typeDeclNameToken(cu, positions, text, ct);
                if (nameToken != null && name.equals(text.substring(nameToken[0], nameToken[1]))) {
                    nameSpanSource = "header_scanner";
                } else {
                    nameToken = null;
                    nameSpanSource = "unknown";
                }
            }
            String declaredIn;
            ClassTree owner = null;
            TreePath ownerPath = null;
            if (parent instanceof ClassTree) {
                owner = (ClassTree) parent;
                ownerPath = parentPath;
                declaredIn = bodyDeclaredIn(owner, ownerPath);
            } else if (parent instanceof NewClassTree) {
                declaredIn = "anonymous_class_body";
            } else if (parentPath == null || parent instanceof CompilationUnitTree) {
                declaredIn = "file";
            } else {
                declaredIn = "local_scope";
            }
            if (anonymous) {
                declaredIn = "anonymous_class_body";
            }
            StringBuilder out = new StringBuilder();
            appendRecord(out, name, typeKind(ct), declaredIn, declStart, declEnd, nameToken, nameSpanSource,
                    owner, ownerPath, ct.getModifiers(), null);
            super.visitClass(ct, unused);
            return null;
        }

        @Override
        public Void visitMethod(MethodTree mt, Void unused) {
            TreePath path = getCurrentPath();
            TreePath parentPath = path.getParentPath();
            Tree parent = parentPath == null ? null : parentPath.getLeaf();
            if (parent instanceof ClassTree) {
                ClassTree owner = (ClassTree) parent;
                String ownerName = declaringTypeName(owner, parentPath);
                boolean constructor = mt.getReturnType() == null;
                String kind = constructor ? "constructor" : "method";
                String name = constructor ? ownerName : mt.getName().toString();
                int[] nameToken;
                String nameSpanSource;
                if (constructor) {
                    nameToken = constructorNameToken(cu, positions, text, mt, ownerName);
                    nameSpanSource = nameToken != null ? "header_scanner" : "unknown";
                } else {
                    nameToken = methodNameToken(cu, positions, text, mt);
                    if (nameToken != null && mt.getName().toString().equals(text.substring(nameToken[0], nameToken[1]))) {
                        nameSpanSource = "header_scanner";
                    } else {
                        nameToken = null;
                        nameSpanSource = "unknown";
                    }
                }
                String declaredIn = bodyDeclaredIn(owner, parentPath);
                StringBuilder out = new StringBuilder();
                appendRecord(out, name, kind, declaredIn, spanStart(mt), spanEnd(mt), nameToken, nameSpanSource,
                        owner, parentPath, mt.getModifiers(), null);
            }
            super.visitMethod(mt, unused);
            return null;
        }

        @Override
        public Void visitVariable(VariableTree vt, Void unused) {
            TreePath path = getCurrentPath();
            TreePath parentPath = path.getParentPath();
            Tree parent = parentPath == null ? null : parentPath.getLeaf();
            if (parent instanceof ClassTree) {
                ClassTree owner = (ClassTree) parent;
                int varStart = spanStart(vt);
                int varEnd = spanEnd(vt);
                int[] layout = layout(owner);
                int bodyOpenBrace = layout[0];
                String kind;
                String declaredIn;
                if (owner.getKind() == Tree.Kind.RECORD
                        && varStart >= 0 && varEnd >= 0
                        && layout[1] >= 0 && layout[2] >= 0
                        && varStart > layout[1] && varEnd <= layout[2]) {
                    kind = "record_component";
                    declaredIn = "record_header";
                } else if (owner.getKind() == Tree.Kind.ENUM
                        && isEnumConstantByScanner(cu, positions, text, vt, varStart, varEnd)) {
                    kind = "enum_constant";
                    declaredIn = "enum_body";
                } else {
                    kind = "field";
                    declaredIn = bodyDeclaredIn(owner, parentPath);
                }
                int[] state = memberState.computeIfAbsent(owner, key -> new int[] {-1, -1});
                int searchStart;
                if (varStart >= 0 && varStart == state[0] && state[1] > varStart) {
                    searchStart = skipCommaAndTrivia(text, state[1], varEnd);
                } else if ("enum_constant".equals(kind)) {
                    long modEnd = vt.getModifiers() == null ? -1 : positions.getEndPosition(cu, vt.getModifiers());
                    searchStart = modEnd >= 0 && modEnd > varStart ? (int) modEnd : varStart;
                } else {
                    searchStart = unwrapBaseTypeEndPos(positions, cu, vt.getType());
                }
                int[] nameToken = variableNameToken(cu, positions, text, vt, searchStart, varEnd);
                String nameSpanSource;
                if (nameToken != null && vt.getName().toString().equals(text.substring(nameToken[0], nameToken[1]))) {
                    nameSpanSource = "header_scanner";
                } else {
                    nameToken = null;
                    nameSpanSource = "unknown";
                }
                StringBuilder out = new StringBuilder();
                appendRecord(out, vt.getName().toString(), kind, declaredIn, varStart, varEnd, nameToken,
                        nameSpanSource, owner, parentPath, vt.getModifiers(), null);
                if (varStart >= 0) {
                    state[0] = varStart;
                    state[1] = varEnd;
                }
            }
            super.visitVariable(vt, unused);
            return null;
        }
    }

    // ------------------------------------------------------------------
    // Batch driver
    // ------------------------------------------------------------------

    static final class SourceFile extends SimpleJavaFileObject {
        final String content;

        SourceFile(String name, String content) {
            super(URI.create("string:///" + name.replace('\\', '/')), JavaFileObject.Kind.SOURCE);
            this.content = content;
        }

        @Override
        public CharSequence getCharContent(boolean ignoreEncodingErrors) {
            return content;
        }
    }

    static String errorsJson(List<String> errors) {
        return "[" + String.join(",", errors) + "]";
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: ExtractJavaSymbols <repoRoot> <argFile>");
            System.exit(2);
        }
        String repoRoot = args[0];
        Path argFile = Path.of(args[1]);
        List<String> relFiles = new ArrayList<>();
        for (String line : Files.readAllLines(argFile, StandardCharsets.UTF_8)) {
            String trimmed = line.trim();
            if (!trimmed.isEmpty()) {
                relFiles.add(trimmed);
            }
        }
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            System.err.println("no system Java compiler available (jdk.compiler module missing)");
            System.exit(3);
        }
        Runtime runtime = Runtime.getRuntime();
        long peakJvmUsedBytes = runtime.totalMemory() - runtime.freeMemory();
        for (String relFile : relFiles) {
            long before = runtime.totalMemory() - runtime.freeMemory();
            peakJvmUsedBytes = Math.max(peakJvmUsedBytes, before);
            try {
                String text = Files.readString(Path.of(repoRoot, relFile), StandardCharsets.UTF_8);
                DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
                JavaFileObject source = new SourceFile(relFile, text);
                JavacTask task = (JavacTask) compiler.getTask(null, null, diagnostics, List.of("-proc:none", "-implicit:none"), null,
                        List.of(source));
                SourcePositions positions = Trees.instance(task).getSourcePositions();
                List<CompilationUnitTree> units = new ArrayList<>();
                for (CompilationUnitTree unit : task.parse()) {
                    units.add(unit);
                }
                List<String> errors = new ArrayList<>();
                for (Diagnostic<? extends JavaFileObject> diagnostic : diagnostics.getDiagnostics()) {
                    if (diagnostic.getKind() != Diagnostic.Kind.ERROR) {
                        continue;
                    }
                    errors.add("{\"line\":" + diagnostic.getLineNumber()
                            + ",\"column\":" + diagnostic.getColumnNumber()
                            + ",\"message\":" + jsonString(diagnostic.getMessage(Locale.ROOT)) + "}");
                }
                String parseStatus = errors.isEmpty() ? "complete" : "partial_syntax_error";
                Collector collector = new Collector(
                        units.isEmpty() ? null : units.get(0), positions, text, relFile,
                        units.isEmpty() ? null : packageNameOf(units.get(0)), parseStatus);
                if (!units.isEmpty()) {
                    CompilationUnitTree cu = units.get(0);
                    collector = new Collector(cu, positions, text, relFile, packageNameOf(cu), parseStatus);
                    scanUnit(collector, cu);
                }
                StringBuilder line = new StringBuilder();
                line.append("{\"type\":\"file\",\"file\":").append(jsonString(relFile))
                        .append(",\"parseStatus\":").append(jsonString(parseStatus))
                        .append(",\"syntaxErrorCount\":").append(errors.size())
                        .append(",\"syntaxErrors\":").append(errorsJson(errors))
                        .append(",\"failed\":false")
                        .append(",\"unconfirmedNameSpans\":").append(collector.unconfirmedNameSpans)
                        .append(",\"symbols\":[").append(String.join(",", collector.symbols)).append("]}");
                System.out.println(line);
                System.out.flush();
            } catch (Throwable error) {
                String reason = error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage());
                StringBuilder line = new StringBuilder();
                line.append("{\"type\":\"file\",\"file\":").append(jsonString(relFile))
                        .append(",\"parseStatus\":\"partial_syntax_error\"")
                        .append(",\"syntaxErrorCount\":0,\"syntaxErrors\":[]")
                        .append(",\"failed\":true,\"failureReason\":").append(jsonString(reason))
                        .append(",\"unconfirmedNameSpans\":0,\"symbols\":[]}");
                System.out.println(line);
                System.out.flush();
            }
            long after = runtime.totalMemory() - runtime.freeMemory();
            peakJvmUsedBytes = Math.max(peakJvmUsedBytes, after);
        }
        StringBuilder summary = new StringBuilder();
        summary.append("{\"type\":\"summary\",\"jdkVersion\":").append(jsonString(Runtime.version().toString()))
                .append(",\"peakJvmUsedBytes\":").append(peakJvmUsedBytes)
                .append(",\"jvmMaxMemoryBytes\":").append(runtime.maxMemory()).append("}");
        System.out.println(summary);
        System.out.flush();
    }

    static String packageNameOf(CompilationUnitTree cu) {
        if (cu == null || cu.getPackageName() == null) {
            return null;
        }
        String name = cu.getPackageName().toString();
        return name.isEmpty() ? null : name;
    }

    static void scanUnit(Collector collector, CompilationUnitTree cu) {
        TreePath root = new TreePath(cu);
        collector.scan(root, null);
    }
}
