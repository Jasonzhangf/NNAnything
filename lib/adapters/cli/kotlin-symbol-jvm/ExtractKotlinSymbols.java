import org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles;
import org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment;
import org.jetbrains.kotlin.com.intellij.openapi.Disposable;
import org.jetbrains.kotlin.com.intellij.openapi.util.Disposer;
import org.jetbrains.kotlin.com.intellij.openapi.editor.Document;
import org.jetbrains.kotlin.com.intellij.psi.PsiElement;
import org.jetbrains.kotlin.com.intellij.psi.PsiErrorElement;
import org.jetbrains.kotlin.config.CompilerConfiguration;
import org.jetbrains.kotlin.lexer.KtTokens;
import org.jetbrains.kotlin.psi.KtClass;
import org.jetbrains.kotlin.psi.KtClassOrObject;
import org.jetbrains.kotlin.psi.KtEnumEntry;
import org.jetbrains.kotlin.psi.KtFile;
import org.jetbrains.kotlin.psi.KtModifierListOwner;
import org.jetbrains.kotlin.psi.KtNamedFunction;
import org.jetbrains.kotlin.psi.KtObjectDeclaration;
import org.jetbrains.kotlin.psi.KtParameter;
import org.jetbrains.kotlin.psi.KtProperty;
import org.jetbrains.kotlin.psi.KtPsiFactory;
import org.jetbrains.kotlin.psi.KtTreeVisitorVoid;
import org.jetbrains.kotlin.psi.KtTypeAlias;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Fixed single-file Kotlin PSI symbol extractor. One JVM batch receives the
 * repository root followed by repo-relative .kt/.kts paths and writes one JSON
 * object to stdout. No Gradle/Maven project is created and no semantic
 * binding is attempted.
 */
public final class ExtractKotlinSymbols {

    private static String escape(String value) {
        if (value == null) {
            return "";
        }
        StringBuilder out = new StringBuilder(value.length());
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

    private static String stringJson(String value) {
        return value == null ? "null" : ("\"" + escape(value) + "\"");
    }

    private static String stringListJson(List<String> values) {
        StringBuilder out = new StringBuilder("[");
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) {
                out.append(",");
            }
            out.append(stringJson(values.get(i)));
        }
        out.append("]");
        return out.toString();
    }

    private static int codePointColumn(String text, int lineStart, int offset) {
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

    private static String spanJson(Document document, String text, PsiElement element) {
        if (element == null) {
            return "null";
        }
        int start = element.getTextRange().getStartOffset();
        int end = element.getTextRange().getEndOffset();
        int startLineNumber = document.getLineNumber(start);
        int endLineNumber = document.getLineNumber(end);
        int startLine = startLineNumber + 1;
        int endLine = endLineNumber + 1;
        int startCol = codePointColumn(text, document.getLineStartOffset(startLineNumber), start);
        int endCol = codePointColumn(text, document.getLineStartOffset(endLineNumber), end);
        return "{\"startLine\":" + startLine
                + ",\"startCol\":" + startCol
                + ",\"endLine\":" + endLine
                + ",\"endCol\":" + endCol + "}";
    }

    private static String modifiersJson(KtModifierListOwner owner) {
        if (owner == null) {
            return "[]";
        }
        List<String> modifiers = new ArrayList<>();
        if (owner.hasModifier(KtTokens.PUBLIC_KEYWORD)) modifiers.add("public");
        if (owner.hasModifier(KtTokens.PRIVATE_KEYWORD)) modifiers.add("private");
        if (owner.hasModifier(KtTokens.INTERNAL_KEYWORD)) modifiers.add("internal");
        if (owner.hasModifier(KtTokens.PROTECTED_KEYWORD)) modifiers.add("protected");
        if (owner.hasModifier(KtTokens.OPEN_KEYWORD)) modifiers.add("open");
        if (owner.hasModifier(KtTokens.ABSTRACT_KEYWORD)) modifiers.add("abstract");
        if (owner.hasModifier(KtTokens.SEALED_KEYWORD)) modifiers.add("sealed");
        if (owner.hasModifier(KtTokens.DATA_KEYWORD)) modifiers.add("data");
        if (owner.hasModifier(KtTokens.VALUE_KEYWORD)) modifiers.add("value");
        if (owner.hasModifier(KtTokens.ENUM_KEYWORD)) modifiers.add("enum");
        if (owner.hasModifier(KtTokens.SUSPEND_KEYWORD)) modifiers.add("suspend");
        if (owner.hasModifier(KtTokens.INLINE_KEYWORD)) modifiers.add("inline");
        if (owner.hasModifier(KtTokens.OVERRIDE_KEYWORD)) modifiers.add("override");
        if (owner.hasModifier(KtTokens.EXTERNAL_KEYWORD)) modifiers.add("external");
        List<String> quoted = new ArrayList<>();
        for (String modifier : modifiers) {
            quoted.add("\"" + modifier + "\"");
        }
        return "[" + String.join(",", quoted) + "]";
    }

    private static String visibilityJson(KtModifierListOwner owner, String declaredIn) {
        if (owner == null) {
            return "\"unknown\"";
        }
        if (owner.hasModifier(KtTokens.PRIVATE_KEYWORD)) return "\"private\"";
        if (owner.hasModifier(KtTokens.PROTECTED_KEYWORD)) return "\"protected\"";
        if (owner.hasModifier(KtTokens.INTERNAL_KEYWORD)) return "\"internal\"";
        if ("local_scope".equals(declaredIn)) return "\"unknown\"";
        return "\"public\"";
    }

    private static String classKind(KtClassOrObject cls) {
        if (cls instanceof KtEnumEntry) return "enum_entry";
        if (cls instanceof KtObjectDeclaration) {
            KtObjectDeclaration object = (KtObjectDeclaration) cls;
            return object.isCompanion() ? "companion_object" : "object";
        }
        if (cls instanceof KtClass) {
            KtClass ktClass = (KtClass) cls;
            if (ktClass.isInterface()) return "interface";
            if (ktClass.isAnnotation()) return "annotation_class";
            if (ktClass.isEnum()) return "enum_class";
            if (ktClass.isData()) return "data_class";
            return "class";
        }
        return "class";
    }

    private static String ownerKindLabel(KtClassOrObject owner) {
        String kind = classKind(owner);
        if ("data_class".equals(kind) || "annotation_class".equals(kind)) {
            return "class";
        }
        return kind;
    }

    private static String declaredInFor(PsiElement declaration, KtClassOrObject owner, boolean local) {
        if (local) return "local_scope";
        if (owner == null) return "file";
        String kind = classKind(owner);
        if ("object".equals(kind) || "companion_object".equals(kind)) return "object_body";
        if ("interface".equals(kind)) return "interface_body";
        return "class_body";
    }

    private static final class OwnerInfo {
        final boolean local;
        final KtClassOrObject owner;

        OwnerInfo(boolean local, KtClassOrObject owner) {
            this.local = local;
            this.owner = owner;
        }
    }

    private static OwnerInfo ownerOf(PsiElement declaration) {
        PsiElement parent = declaration.getParent();
        while (parent != null) {
            if (parent instanceof KtNamedFunction) {
                return new OwnerInfo(true, null);
            }
            if (parent instanceof KtClassOrObject) {
                return new OwnerInfo(false, (KtClassOrObject) parent);
            }
            parent = parent.getParent();
        }
        return new OwnerInfo(false, null);
    }

    private static List<String> lexicalScopeOf(PsiElement declaration, String packageName) {
        List<String> reversed = new ArrayList<>();
        PsiElement parent = declaration.getParent();
        while (parent != null) {
            if (parent instanceof KtClassOrObject) {
                KtClassOrObject cls = (KtClassOrObject) parent;
                String name = effectiveName(cls);
                if (name != null) {
                    reversed.add(classKind(cls) + ":" + name);
                }
            } else if (parent instanceof KtNamedFunction) {
                KtNamedFunction function = (KtNamedFunction) parent;
                String name = function.getName();
                if (name != null) {
                    reversed.add("function:" + name);
                }
            }
            parent = parent.getParent();
        }
        List<String> scope = new ArrayList<>();
        if (packageName != null && !packageName.isEmpty()) {
            scope.add("package:" + packageName);
        }
        for (int i = reversed.size() - 1; i >= 0; i--) {
            scope.add(reversed.get(i));
        }
        return scope;
    }

    private static String effectiveName(KtClassOrObject cls) {
        if (cls instanceof KtObjectDeclaration && ((KtObjectDeclaration) cls).isCompanion()) {
            String raw = cls.getName();
            return raw == null ? "Companion" : raw;
        }
        return cls.getName();
    }

    private static void appendNameSpan(StringBuilder out, Document document, String text, PsiElement identifier) {
        if (identifier == null) {
            out.append("\"nameSpan\":null,\"nameSpanSource\":\"null_reason:psi_name_identifier_unavailable\"");
        } else {
            out.append("\"nameSpan\":").append(spanJson(document, text, identifier))
                    .append(",\"nameSpanSource\":\"psi_name_identifier\"");
        }
    }

    private static String symbolIdJson(String relFile, String name, PsiElement declaration) {
        int start = declaration.getTextRange().getStartOffset();
        int end = declaration.getTextRange().getEndOffset();
        return stringJson(relFile + "#" + name + "@" + start + "-" + end);
    }

    private static String receiverTypeText(KtNamedFunction function) {
        return function.getReceiverTypeReference() == null ? null : function.getReceiverTypeReference().getText();
    }

    private static String receiverTypeText(KtProperty property) {
        return property.getReceiverTypeReference() == null ? null : property.getReceiverTypeReference().getText();
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            throw new IllegalArgumentException("expected repository root followed by relative Kotlin files");
        }
        String repoRoot = args[0];
        Runtime runtime = Runtime.getRuntime();
        long peakJvmUsedBytes = runtime.totalMemory() - runtime.freeMemory();

        Disposable disposable = Disposer.newDisposable();
        KotlinCoreEnvironment environment = KotlinCoreEnvironment.createForProduction(
                disposable, new CompilerConfiguration(), EnvironmentConfigFiles.JVM_CONFIG_FILES
        );
        KtPsiFactory factory = new KtPsiFactory(environment.getProject());

        List<String> fileReports = new ArrayList<>();
        List<String> symbols = new ArrayList<>();

        for (int index = 1; index < args.length; index++) {
            String relFile = args[index];
            Path absolute = Path.of(repoRoot, relFile);
            long before = runtime.totalMemory() - runtime.freeMemory();
            peakJvmUsedBytes = Math.max(peakJvmUsedBytes, before);

            try {
                // Kotlin PSI rejects CRLF source text in createFile; normalize
                // line endings before parsing. Only line/column facts are
                // exported, so the normalization does not change display
                // coordinates.
                final String sourceText = Files.readString(absolute, StandardCharsets.UTF_8)
                        .replace("\r\n", "\n")
                        .replace('\r', '\n');
                final KtFile ktFile = factory.createFile(absolute.getFileName().toString(), sourceText);
                final Document fileDocument = ktFile.getViewProvider().getDocument();
                final String fileText = fileDocument.getText();
                final String filePackageName = ktFile.getPackageFqName().asString();
                final List<PsiErrorElement> errorElements = new ArrayList<>();
                final List<String> fileSymbols = new ArrayList<>();

                // Pre-pass: collect PSI error elements so per-file parseStatus is
                // final before the symbol-emitting traversal runs.
                ktFile.accept(new KtTreeVisitorVoid() {
                    @Override
                    public void visitElement(PsiElement element) {
                        if (element instanceof PsiErrorElement) {
                            errorElements.add((PsiErrorElement) element);
                        }
                        element.acceptChildren(this);
                    }
                });
                final String fileParseStatus = errorElements.isEmpty() ? "complete" : "partial_syntax_error";

                ktFile.accept(new KtTreeVisitorVoid() {
                    @Override
                    public void visitClassOrObject(KtClassOrObject cls) {
                        boolean objectLiteral = cls instanceof KtObjectDeclaration
                                && ((KtObjectDeclaration) cls).isObjectLiteral();
                        if (!objectLiteral) {
                            emitClassOrObject(cls);
                        }
                        cls.acceptChildren(this);
                    }

                    @Override
                    public void visitNamedFunction(KtNamedFunction function) {
                        emitNamedFunction(function);
                        function.acceptChildren(this);
                    }

                    @Override
                    public void visitProperty(KtProperty property) {
                        if (!property.isLocal()) {
                            emitProperty(property);
                        }
                        property.acceptChildren(this);
                    }

                    @Override
                    public void visitTypeAlias(KtTypeAlias typeAlias) {
                        emitTypeAlias(typeAlias);
                    }

                    private void emitClassOrObject(KtClassOrObject cls) {
                        String name = effectiveName(cls);
                        if (name == null) {
                            return;
                        }
                        OwnerInfo ownerInfo = ownerOf(cls);
                        String declaredIn = declaredInFor(cls, ownerInfo.owner, ownerInfo.local);
                        StringBuilder out = new StringBuilder();
                        out.append("{\"symbolId\":").append(symbolIdJson(relFile, name, cls))
                                .append(",\"name\":").append(stringJson(name))
                                .append(",\"kind\":").append(stringJson(classKind(cls)))
                                .append(",\"file\":").append(stringJson(relFile))
                                .append(",\"declSpan\":").append(spanJson(fileDocument, fileText, cls))
                                .append(",");
                        appendNameSpan(out, fileDocument, fileText, cls.getNameIdentifier());
                        out.append(",\"lexicalScope\":").append(stringListJson(lexicalScopeOf(cls, filePackageName)))
                                .append(",\"ownerType\":").append(stringJson(ownerInfo.owner == null ? null : effectiveName(ownerInfo.owner)))
                                .append(",\"ownerKind\":").append(stringJson(ownerInfo.owner == null ? null : ownerKindLabel(ownerInfo.owner)))
                                .append(",\"receiverType\":null")
                                .append(",\"modifiers\":").append(modifiersJson(cls))
                                .append(",\"visibility\":").append(visibilityJson(cls, declaredIn))
                                .append(",\"declaredIn\":").append(stringJson(declaredIn))
                                .append(",\"parseStatus\":").append(stringJson(fileParseStatus))
                                .append("}");
                        fileSymbols.add(out.toString());
                        symbols.add(out.toString());

                        if (cls instanceof KtClass) {
                            KtClass ktClass = (KtClass) cls;
                            for (KtParameter parameter : ktClass.getPrimaryConstructorParameters()) {
                                if (parameter.hasValOrVar() && parameter.getName() != null) {
                                    emitPrimaryConstructorProperty(name, parameter);
                                }
                            }
                        }
                    }

                    private void emitPrimaryConstructorProperty(String className, KtParameter parameter) {
                        OwnerInfo ownerInfo = ownerOf(parameter);
                        KtClassOrObject owner = ownerInfo.owner;
                        String declaredIn = "primary_constructor";
                        String receiverType = parameter.getReceiverTypeReference() == null
                                ? null : parameter.getReceiverTypeReference().getText();
                        StringBuilder out = new StringBuilder();
                        out.append("{\"symbolId\":").append(symbolIdJson(relFile, parameter.getName(), parameter))
                                .append(",\"name\":").append(stringJson(parameter.getName()))
                                .append(",\"kind\":\"property\"")
                                .append(",\"file\":").append(stringJson(relFile))
                                .append(",\"declSpan\":").append(spanJson(fileDocument, fileText, parameter))
                                .append(",");
                        appendNameSpan(out, fileDocument, fileText, parameter.getNameIdentifier());
                        out.append(",\"lexicalScope\":").append(stringListJson(lexicalScopeOf(parameter, filePackageName)))
                                .append(",\"ownerType\":").append(stringJson(className))
                                .append(",\"ownerKind\":").append(stringJson(owner == null ? "class" : ownerKindLabel(owner)))
                                .append(",\"receiverType\":").append(stringJson(receiverType))
                                .append(",\"modifiers\":").append(modifiersJson(parameter))
                                .append(",\"visibility\":").append(visibilityJson(parameter, declaredIn))
                                .append(",\"declaredIn\":").append(stringJson(declaredIn))
                                .append(",\"parseStatus\":").append(stringJson(fileParseStatus))
                                .append("}");
                        fileSymbols.add(out.toString());
                        symbols.add(out.toString());
                    }

                    private void emitNamedFunction(KtNamedFunction function) {
                        String name = function.getName();
                        if (name == null) {
                            return;
                        }
                        OwnerInfo ownerInfo = ownerOf(function);
                        boolean extension = function.getReceiverTypeReference() != null;
                        String kind = extension ? "extension_function"
                                : (ownerInfo.local || ownerInfo.owner == null ? "function" : "method");
                        String declaredIn = declaredInFor(function, ownerInfo.owner, ownerInfo.local);
                        String receiverType = receiverTypeText(function);
                        StringBuilder out = new StringBuilder();
                        out.append("{\"symbolId\":").append(symbolIdJson(relFile, name, function))
                                .append(",\"name\":").append(stringJson(name))
                                .append(",\"kind\":").append(stringJson(kind))
                                .append(",\"file\":").append(stringJson(relFile))
                                .append(",\"declSpan\":").append(spanJson(fileDocument, fileText, function))
                                .append(",");
                        appendNameSpan(out, fileDocument, fileText, function.getNameIdentifier());
                        out.append(",\"lexicalScope\":").append(stringListJson(lexicalScopeOf(function, filePackageName)))
                                .append(",\"ownerType\":").append(stringJson(ownerInfo.owner == null ? null : effectiveName(ownerInfo.owner)))
                                .append(",\"ownerKind\":").append(stringJson(ownerInfo.owner == null ? null : ownerKindLabel(ownerInfo.owner)))
                                .append(",\"receiverType\":").append(stringJson(receiverType))
                                .append(",\"modifiers\":").append(modifiersJson(function))
                                .append(",\"visibility\":").append(visibilityJson(function, declaredIn))
                                .append(",\"declaredIn\":").append(stringJson(declaredIn))
                                .append(",\"parseStatus\":").append(stringJson(fileParseStatus))
                                .append("}");
                        fileSymbols.add(out.toString());
                        symbols.add(out.toString());
                    }

                    private void emitProperty(KtProperty property) {
                        String name = property.getName();
                        if (name == null) {
                            return;
                        }
                        OwnerInfo ownerInfo = ownerOf(property);
                        String declaredIn = declaredInFor(property, ownerInfo.owner, ownerInfo.local);
                        String receiverType = receiverTypeText(property);
                        StringBuilder out = new StringBuilder();
                        out.append("{\"symbolId\":").append(symbolIdJson(relFile, name, property))
                                .append(",\"name\":").append(stringJson(name))
                                .append(",\"kind\":\"property\"")
                                .append(",\"file\":").append(stringJson(relFile))
                                .append(",\"declSpan\":").append(spanJson(fileDocument, fileText, property))
                                .append(",");
                        appendNameSpan(out, fileDocument, fileText, property.getNameIdentifier());
                        out.append(",\"lexicalScope\":").append(stringListJson(lexicalScopeOf(property, filePackageName)))
                                .append(",\"ownerType\":").append(stringJson(ownerInfo.owner == null ? null : effectiveName(ownerInfo.owner)))
                                .append(",\"ownerKind\":").append(stringJson(ownerInfo.owner == null ? null : ownerKindLabel(ownerInfo.owner)))
                                .append(",\"receiverType\":").append(stringJson(receiverType))
                                .append(",\"modifiers\":").append(modifiersJson(property))
                                .append(",\"visibility\":").append(visibilityJson(property, declaredIn))
                                .append(",\"declaredIn\":").append(stringJson(declaredIn))
                                .append(",\"parseStatus\":").append(stringJson(fileParseStatus))
                                .append("}");
                        fileSymbols.add(out.toString());
                        symbols.add(out.toString());
                    }

                    private void emitTypeAlias(KtTypeAlias typeAlias) {
                        String name = typeAlias.getName();
                        if (name == null) {
                            return;
                        }
                        OwnerInfo ownerInfo = ownerOf(typeAlias);
                        String declaredIn = declaredInFor(typeAlias, ownerInfo.owner, ownerInfo.local);
                        StringBuilder out = new StringBuilder();
                        out.append("{\"symbolId\":").append(symbolIdJson(relFile, name, typeAlias))
                                .append(",\"name\":").append(stringJson(name))
                                .append(",\"kind\":\"type_alias\"")
                                .append(",\"file\":").append(stringJson(relFile))
                                .append(",\"declSpan\":").append(spanJson(fileDocument, fileText, typeAlias))
                                .append(",");
                        appendNameSpan(out, fileDocument, fileText, typeAlias.getNameIdentifier());
                        out.append(",\"lexicalScope\":").append(stringListJson(lexicalScopeOf(typeAlias, filePackageName)))
                                .append(",\"ownerType\":").append(stringJson(ownerInfo.owner == null ? null : effectiveName(ownerInfo.owner)))
                                .append(",\"ownerKind\":").append(stringJson(ownerInfo.owner == null ? null : ownerKindLabel(ownerInfo.owner)))
                                .append(",\"receiverType\":null")
                                .append(",\"modifiers\":").append(modifiersJson(typeAlias))
                                .append(",\"visibility\":").append(visibilityJson(typeAlias, declaredIn))
                                .append(",\"declaredIn\":").append(stringJson(declaredIn))
                                .append(",\"parseStatus\":").append(stringJson(fileParseStatus))
                                .append("}");
                        fileSymbols.add(out.toString());
                        symbols.add(out.toString());
                    }
                });

                List<String> errorJson = new ArrayList<>();
                for (PsiErrorElement error : errorElements) {
                    int errorStart = error.getTextRange().getStartOffset();
                    int lineNumber = fileDocument.getLineNumber(errorStart);
                    int column = codePointColumn(fileText, fileDocument.getLineStartOffset(lineNumber), errorStart);
                    errorJson.add("{\"line\":" + (lineNumber + 1)
                            + ",\"column\":" + column
                            + ",\"errorDescription\":" + stringJson(error.getErrorDescription()) + "}");
                }

                fileReports.add("{\"file\":" + stringJson(relFile)
                        + ",\"parseStatus\":" + stringJson(fileParseStatus)
                        + ",\"psiErrorCount\":" + errorElements.size()
                        + ",\"psiErrors\":[" + String.join(",", errorJson) + "]"
                        + ",\"symbolCount\":" + fileSymbols.size()
                        + ",\"failed\":false}");

                long after = runtime.totalMemory() - runtime.freeMemory();
                peakJvmUsedBytes = Math.max(peakJvmUsedBytes, after);
            } catch (Throwable error) {
                String reason = error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage());
                fileReports.add("{\"file\":" + stringJson(relFile)
                        + ",\"parseStatus\":\"partial_syntax_error\""
                        + ",\"psiErrorCount\":0"
                        + ",\"psiErrors\":[]"
                        + ",\"symbolCount\":0"
                        + ",\"failed\":true"
                        + ",\"failureReason\":" + stringJson(reason) + "}");
                long after = runtime.totalMemory() - runtime.freeMemory();
                peakJvmUsedBytes = Math.max(peakJvmUsedBytes, after);
            }
        }

        Disposer.dispose(disposable);

        StringBuilder payload = new StringBuilder();
        payload.append("{\"peakJvmUsedBytes\":").append(peakJvmUsedBytes)
                .append(",\"jvmMaxMemoryBytes\":").append(runtime.maxMemory())
                .append(",\"fileReports\":[").append(String.join(",", fileReports)).append("]")
                .append(",\"symbols\":[").append(String.join(",", symbols)).append("]}");
        System.out.println(payload.toString());
    }
}
