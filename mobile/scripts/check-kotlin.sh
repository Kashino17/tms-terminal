#!/usr/bin/env bash
#
# Übersetzt die nativen Kotlin-Dateien OHNE den vollen Gradle-Build.
#
# Warum es das gibt: `:app:compileDebugKotlin` braucht JitPack
# (`BlurView` aus expo-blur, `Android-Image-Cropper` aus expo-image-picker). Ohne
# Netz oder bei flackerndem DNS scheitert der Build daran — an Stellen, die mit
# dieser Arbeit nichts zu tun haben. Der Kotlin-Compiler selbst liegt im
# Gradle-Wrapper-Cache und reicht, um die eine Datei zu prüfen, in der die
# Alarm-Logik steckt.
#
# Geprüft wird: Kotlin-Syntax und die Android-API-Nutzung. Nicht geprüft wird die
# Anbindung an React Native (dafür sind Attrappen nötig) und der
# AdhanFullscreenActivity (braucht appcompat und die generierte R-Klasse).
#
# Aufruf:  bash scripts/check-kotlin.sh
set -uo pipefail

W="${TMPDIR:-/tmp}/tms-kotlin-check"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO/mobile/android/app/src/main/java/com/tms/terminal"
GL="$(ls -d ~/.gradle/wrapper/dists/gradle-8.14.3-all/*/gradle-8.14.3/lib 2>/dev/null | head -1)"
AJ="$HOME/Library/Android/sdk/platforms/android-34/android.jar"

if [ -z "$GL" ] || [ ! -f "$AJ" ]; then
  echo "SKIP — Gradle-Distribution oder android.jar (android-34) fehlt."
  echo "       Erwartet: \$HOME/Library/Android/sdk/platforms/android-34"
  exit 0
fi
if ! command -v javac >/dev/null 2>&1; then
  echo "SKIP — kein javac im Pfad (JDK fehlt)."
  exit 0
fi

rm -rf "$W" && mkdir -p "$W/stubs/com/facebook/react/bridge"

# Attrappen der React-Native-Bruecke: nur Typen, damit die Datei uebersetzbar wird.
cat > "$W/stubs/com/facebook/react/bridge/ReactApplicationContext.java" <<'EOF'
package com.facebook.react.bridge;
import android.content.Context;
import android.content.ContextWrapper;
public class ReactApplicationContext extends ContextWrapper {
  public ReactApplicationContext(Context base) { super(base); }
  public Context getApplicationContext() { return getBaseContext(); }
}
EOF
cat > "$W/stubs/com/facebook/react/bridge/ReactContextBaseJavaModule.java" <<'EOF'
package com.facebook.react.bridge;
public abstract class ReactContextBaseJavaModule {
  protected final ReactApplicationContext reactApplicationContext;
  public ReactContextBaseJavaModule(ReactApplicationContext c) { this.reactApplicationContext = c; }
  public abstract String getName();
  public ReactApplicationContext getReactApplicationContext() { return reactApplicationContext; }
}
EOF
cat > "$W/stubs/com/facebook/react/bridge/ReactMethod.java" <<'EOF'
package com.facebook.react.bridge;
import java.lang.annotation.*;
@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.METHOD)
public @interface ReactMethod { boolean isBlockingSynchronousMethod() default false; }
EOF
cat > "$W/stubs/com/facebook/react/bridge/Promise.java" <<'EOF'
package com.facebook.react.bridge;
public interface Promise {
  void resolve(Object value);
  void reject(String code, String message);
}
EOF

javac -nowarn -cp "$AJ" -d "$W/stubs-out" "$W"/stubs/com/facebook/react/bridge/*.java || {
  echo "FEHLER — die Attrappen selbst bauen nicht."
  exit 1
}

# androidx.core aus dem Gradle-Cache (NotificationCompat braucht der Receiver).
CORE_AAR="$(ls ~/.gradle/caches/modules-2/files-2.1/androidx.core/core/*/*/core-*.aar 2>/dev/null | grep -v sources | head -1)"
CORE_JAR=""
if [ -n "$CORE_AAR" ]; then
  mkdir -p "$W/aar" && (cd "$W/aar" && unzip -oq "$CORE_AAR" classes.jar && mv classes.jar core.jar) && CORE_JAR="$W/aar/core.jar"
fi

# AdhanAlarmReceiver braucht androidx und die generierte R-Klasse — beides gibt es
# erst nach einem vollen Build. Fuer die Uebersetzung von AdhanModule.kt reicht die
# Signatur; die Datei selbst wird nicht angefasst.
mkdir -p "$W/iso/com/tms/terminal"
cat > "$W/iso/com/tms/terminal/AdhanAlarmReceiver.kt" <<'EOF'
package com.tms.terminal
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
class AdhanAlarmReceiver : BroadcastReceiver() { override fun onReceive(c: Context?, i: Intent?) {} }
EOF

COMPILER_CP="$GL/kotlin-compiler-embeddable-2.0.21.jar:$GL/kotlin-stdlib-2.0.21.jar:$GL/trove4j-1.0.20200330.jar:$GL/kotlinx-coroutines-core-jvm-1.6.4.jar:$GL/annotations-24.0.1.jar"
SOURCE_CP="$AJ:$W/stubs-out:$GL/kotlin-stdlib-2.0.21.jar${CORE_JAR:+:$CORE_JAR}"

echo "Übersetze AdhanModule.kt (AlarmManager, PendingIntent, Settings) …"
# Achtung: der Compiler laeuft durch `tee`, nicht durch `| grep` — sonst waere der
# Status des Skripts der von grep/head und ein Fehler faellt durch. Genau das war
# kurzzeitig kaputt.
LOG="$W/kotlin.log"
java -cp "$COMPILER_CP" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
  -nowarn -d "$W/out" -cp "$SOURCE_CP" \
  "$SRC/AdhanModule.kt" "$W/iso/com/tms/terminal/AdhanAlarmReceiver.kt" \
  > "$LOG" 2>&1
RC=$?
grep -vE '^(warning|info):' "$LOG" | grep -E 'error:|exception:' | head -20

if [ ! -f "$W/out/com/tms/terminal/AdhanModule.class" ] || [ "$RC" -ne 0 ]; then
  echo "FEHLER — AdhanModule.kt wurde nicht übersetzt (siehe Meldung oben)."
  exit 1
fi
echo "OK — AdhanModule.class erzeugt"
exit 0