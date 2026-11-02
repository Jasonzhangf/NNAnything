package com.apktry.dumper;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.os.FileObserver;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;

public final class DumpProvider extends ContentProvider {
    private static void copy(File src, File dst) throws Exception {
        FileInputStream in = new FileInputStream(src);
        try {
            FileOutputStream out = new FileOutputStream(dst);
            try {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) >= 0) {
                    if (n > 0) out.write(buf, 0, n);
                }
                out.getFD().sync();
            } finally { out.close(); }
        } finally { in.close(); }
    }

    @Override public boolean onCreate() {
        final android.content.Context context = getContext();
        final FileObserver observer = new FileObserver(context.getCodeCacheDir().getAbsolutePath(), FileObserver.CREATE | FileObserver.CLOSE_WRITE) {
            @Override public void onEvent(int event, String name) {
                if (name == null) return;
                try {
                    File src = new File(context.getCodeCacheDir(), name);
                    if (src.isFile() && name.endsWith(".dex")) {
                        File out = context.getExternalFilesDir("dumps");
                        if (out != null) { out.mkdirs(); copy(src, new File(out, name)); }
                    }
                } catch (Exception ignored) { }
            }
        };
        observer.startWatching();
        new Thread(new Runnable() {
            @Override public void run() {
                for (int attempt = 0; attempt < 30; attempt++) {
                    try {
                        File out = context.getExternalFilesDir("dumps");
                        if (out != null) {
                            out.mkdirs();
                            File[] dirs = { context.getCodeCacheDir(), context.getFilesDir() };
                            for (File dir : dirs) {
                                File[] files = dir.listFiles();
                                if (files == null) continue;
                                for (File f : files) {
                                    if (f.isFile() && (f.getName().endsWith(".dex") || f.getName().startsWith(".s"))) {
                                        copy(f, new File(out, f.getName()));
                                    }
                                }
                            }
                        }
                        Thread.sleep(1000L);
                    } catch (Exception ignored) { }
                }
            }
        }, "apktry-dex-export").start();
        return true;
    }
    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String so) { return null; }
    @Override public String getType(Uri u) { return null; }
    @Override public Uri insert(Uri u, ContentValues v) { return null; }
    @Override public int delete(Uri u, String s, String[] a) { return 0; }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { return 0; }
    @Override public ParcelFileDescriptor openFile(Uri u, String mode) { return null; }
}
