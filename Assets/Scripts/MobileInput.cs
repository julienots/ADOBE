using System.Collections.Generic;
using UnityEngine;

// Contrôles tactiles : joystick virtuel à gauche, boutons SAUT / DASH à droite,
// et glisser le doigt ailleurs à droite pour tourner la caméra.
[DefaultExecutionOrder(-100)]
public class MobileInput : MonoBehaviour
{
    public static bool Enabled => Application.isMobilePlatform || Input.touchSupported;
    public static Vector2 Move { get; private set; }
    public static bool JumpDown { get; private set; }
    public static bool DashDown { get; private set; }
    public static float CameraDelta { get; private set; }
    public static bool ShowControls;

    enum Role { Joystick, Jump, Dash, Camera }

    readonly Dictionary<int, Role> roles = new Dictionary<int, Role>();
    Vector2 stickOrigin, stickPos;
    bool stickActive;

    float ButtonRadius => Screen.height * 0.09f;
    float StickRadius => Screen.height * 0.13f;
    // Centres en coordonnées écran (origine en bas à gauche, comme Input.touches).
    Vector2 JumpCenter => new Vector2(Screen.width - ButtonRadius * 3.4f, ButtonRadius * 1.5f);
    Vector2 DashCenter => new Vector2(Screen.width - ButtonRadius * 1.5f, ButtonRadius * 3.2f);

    void Update()
    {
        JumpDown = DashDown = false;
        CameraDelta = 0f;
        if (!Enabled) return;

        Vector2 move = Vector2.zero;
        stickActive = false;

        for (int i = 0; i < Input.touchCount; i++)
        {
            Touch t = Input.GetTouch(i);

            if (t.phase == TouchPhase.Began)
            {
                Role role;
                if (Vector2.Distance(t.position, JumpCenter) < ButtonRadius * 1.25f) { role = Role.Jump; JumpDown = true; }
                else if (Vector2.Distance(t.position, DashCenter) < ButtonRadius * 1.25f) { role = Role.Dash; DashDown = true; }
                else if (t.position.x < Screen.width * 0.5f) { role = Role.Joystick; stickOrigin = t.position; }
                else role = Role.Camera;
                roles[t.fingerId] = role;
            }

            if (!roles.TryGetValue(t.fingerId, out Role r)) continue;

            if (t.phase == TouchPhase.Ended || t.phase == TouchPhase.Canceled)
            {
                roles.Remove(t.fingerId);
                continue;
            }

            if (r == Role.Joystick)
            {
                stickActive = true;
                stickPos = t.position;
                move = Vector2.ClampMagnitude((t.position - stickOrigin) / StickRadius, 1f);
            }
            else if (r == Role.Camera)
            {
                CameraDelta += t.deltaPosition.x / Screen.width * 360f;
            }
        }

        Move = move;
    }

    void OnGUI()
    {
        if (!Enabled || !ShowControls) return;
        GUI.matrix = Matrix4x4.identity;

        if (stickActive)
        {
            DrawCircle(stickOrigin, StickRadius, new Color(1f, 1f, 1f, 0.15f));
            Vector2 knob = stickOrigin + Move * StickRadius;
            DrawCircle(knob, StickRadius * 0.45f, new Color(1f, 1f, 1f, 0.45f));
        }
        else
        {
            DrawCircle(new Vector2(StickRadius * 1.6f, StickRadius * 1.4f), StickRadius, new Color(1f, 1f, 1f, 0.08f));
        }

        DrawButton(JumpCenter, "SAUT", new Color(0.3f, 0.9f, 1f, 0.4f));
        DrawButton(DashCenter, "DASH", new Color(1f, 0.8f, 0.2f, 0.4f));
    }

    static Texture2D circleTex;

    static void DrawCircle(Vector2 center, float radius, Color color)
    {
        if (circleTex == null)
        {
            const int size = 128;
            circleTex = new Texture2D(size, size, TextureFormat.RGBA32, false);
            for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
            {
                float d = Vector2.Distance(new Vector2(x, y), new Vector2(size / 2f, size / 2f)) / (size / 2f);
                circleTex.SetPixel(x, y, new Color(1f, 1f, 1f, Mathf.Clamp01((1f - d) * 20f)));
            }
            circleTex.Apply();
        }
        var old = GUI.color;
        GUI.color = color;
        // Conversion vers les coordonnées GUI (origine en haut à gauche).
        GUI.DrawTexture(new Rect(center.x - radius, Screen.height - center.y - radius, radius * 2f, radius * 2f), circleTex);
        GUI.color = old;
    }

    static GUIStyle labelStyle;

    void DrawButton(Vector2 center, string label, Color color)
    {
        DrawCircle(center, ButtonRadius, color);
        if (labelStyle == null)
            labelStyle = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter, fontStyle = FontStyle.Bold };
        labelStyle.fontSize = Mathf.RoundToInt(ButtonRadius * 0.4f);
        GUI.Label(new Rect(center.x - ButtonRadius, Screen.height - center.y - ButtonRadius, ButtonRadius * 2f, ButtonRadius * 2f), label, labelStyle);
    }
}
