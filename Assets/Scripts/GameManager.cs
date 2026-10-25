using System.Collections;
using System.Collections.Generic;
using UnityEngine;

// ORB RUSH : ramasse toutes les orbes de la vague, évite les cubes rouges,
// et éjecte-les de l'arène avec ton dash pour des points bonus.
public class GameManager : MonoBehaviour
{
    public static GameManager I { get; private set; }

    enum State { Menu, Playing, GameOver }

    const float ArenaSize = 36f;
    const float KillY = -10f;
    const int StartLives = 3;

    State state = State.Menu;
    int score, lives, wave, highScore, seed;
    float invulnerableUntil;
    string banner;
    float bannerUntil;

    Camera cam;
    CameraFollow camFollow;
    PlayerController player;
    Renderer playerRenderer;
    Transform arenaRoot, dynamicRoot;
    readonly List<Vector3> platformTops = new List<Vector3>();
    readonly List<Orb> orbs = new List<Orb>();
    readonly List<Enemy> enemies = new List<Enemy>();
    Color playerColor;

    void Awake()
    {
        I = this;
        highScore = PlayerPrefs.GetInt("OrbRush_HighScore", 0);
        SetupCameraAndLight();
        BuildArena(Random.Range(1, 99999));
        CreatePlayer();
    }

    // ---------- Mise en place ----------

    void SetupCameraAndLight()
    {
        cam = Camera.main;
        if (cam == null)
        {
            var go = new GameObject("Main Camera") { tag = "MainCamera" };
            cam = go.AddComponent<Camera>();
            go.AddComponent<AudioListener>();
        }
        var bg = new Color(0.07f, 0.06f, 0.15f);
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = bg;
        cam.fieldOfView = 60f;
        cam.transform.position = new Vector3(0f, 8f, -11f);
        camFollow = cam.gameObject.AddComponent<CameraFollow>();

        RenderSettings.fog = true;
        RenderSettings.fogColor = bg;
        RenderSettings.fogMode = FogMode.Linear;
        RenderSettings.fogStartDistance = 25f;
        RenderSettings.fogEndDistance = 70f;
        RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
        RenderSettings.ambientLight = new Color(0.35f, 0.33f, 0.45f);

        Light sun = null;
        foreach (var l in FindObjectsByType<Light>(FindObjectsSortMode.None))
            if (l.type == LightType.Directional) { sun = l; break; }
        if (sun == null)
        {
            sun = new GameObject("Directional Light").AddComponent<Light>();
            sun.type = LightType.Directional;
        }
        sun.transform.rotation = Quaternion.Euler(50f, -30f, 0f);
        sun.intensity = 1.1f;
        sun.color = new Color(1f, 0.95f, 0.85f);
        sun.shadows = LightShadows.Soft;
    }

    void BuildArena(int newSeed)
    {
        seed = newSeed;
        if (arenaRoot != null) Destroy(arenaRoot.gameObject);
        arenaRoot = new GameObject("Arena").transform;
        platformTops.Clear();

        var oldState = Random.state;
        Random.InitState(seed);

        // Palette tirée au hasard pour chaque arène.
        float hue = Random.value;
        Color groundA = Color.HSVToRGB(hue, 0.35f, 0.55f);
        Color groundB = Color.HSVToRGB(hue, 0.30f, 0.45f);
        Color pillarColor = Color.HSVToRGB((hue + 0.5f) % 1f, 0.45f, 0.7f);
        Color platColor = Color.HSVToRGB((hue + 0.25f) % 1f, 0.5f, 0.8f);
        playerColor = Color.HSVToRGB((hue + 0.6f) % 1f, 0.8f, 1f);

        // Sol : un seul grand collider, et un damier purement visuel par-dessus.
        Factory.Prim(PrimitiveType.Cube, "Ground", new Vector3(0f, -0.5f, 0f),
                     new Vector3(ArenaSize, 1f, ArenaSize), groundB, arenaRoot);
        const int tiles = 6;
        float tileSize = ArenaSize / tiles;
        for (int x = 0; x < tiles; x++)
        for (int z = 0; z < tiles; z++)
        {
            if ((x + z) % 2 == 0) continue;
            var pos = new Vector3((x + 0.5f) * tileSize - ArenaSize / 2f, 0.005f, (z + 0.5f) * tileSize - ArenaSize / 2f);
            var t = Factory.Prim(PrimitiveType.Cube, "Tile", pos, new Vector3(tileSize, 0.01f, tileSize), groundA, arenaRoot);
            Factory.RemoveCollider(t);
        }

        // Piliers aléatoires (jamais au centre, où le joueur apparaît).
        int pillars = Random.Range(6, 12);
        for (int i = 0; i < pillars; i++)
        {
            Vector3 p = RandomArenaPoint(4f);
            float h = Random.Range(1f, 4.5f);
            float w = Random.Range(1f, 2.5f);
            var go = Factory.Prim(PrimitiveType.Cube, "Pillar", new Vector3(p.x, h / 2f, p.z),
                                  new Vector3(w, h, w), pillarColor, arenaRoot);
            go.transform.rotation = Quaternion.Euler(0f, Random.Range(0f, 90f), 0f);
        }

        // Plateformes flottantes, chacune accueillera une orbe dorée.
        int platforms = Random.Range(2, 5);
        for (int i = 0; i < platforms; i++)
        {
            Vector3 p = RandomArenaPoint(6f);
            float topY = Random.Range(1.5f, 2.1f);
            Factory.Prim(PrimitiveType.Cube, "Platform", new Vector3(p.x, topY - 0.25f, p.z),
                         new Vector3(3.5f, 0.5f, 3.5f), platColor, arenaRoot, 0.3f);
            platformTops.Add(new Vector3(p.x, topY, p.z));
        }

        // Bordure lumineuse pour bien voir le bord du vide.
        Color edge = Color.HSVToRGB((hue + 0.5f) % 1f, 0.9f, 1f);
        float half = ArenaSize / 2f;
        for (int i = 0; i < 4; i++)
        {
            bool alongX = i < 2;
            float sign = i % 2 == 0 ? 1f : -1f;
            var pos = alongX ? new Vector3(0f, 0.02f, sign * half) : new Vector3(sign * half, 0.02f, 0f);
            var scale = alongX ? new Vector3(ArenaSize, 0.04f, 0.3f) : new Vector3(0.3f, 0.04f, ArenaSize);
            var e = Factory.Prim(PrimitiveType.Cube, "Edge", pos, scale, edge, arenaRoot, 2f);
            Factory.RemoveCollider(e);
        }

        Random.state = oldState;
        Physics.SyncTransforms();

        if (playerRenderer != null) playerRenderer.sharedMaterial = Factory.Mat(playerColor, 0.4f);
    }

    Vector3 RandomArenaPoint(float minDistFromCenter)
    {
        float lim = ArenaSize / 2f - 2f;
        for (int i = 0; i < 50; i++)
        {
            var p = new Vector3(Random.Range(-lim, lim), 0f, Random.Range(-lim, lim));
            if (p.magnitude >= minDistFromCenter) return p;
        }
        return new Vector3(lim, 0f, lim);
    }

    void CreatePlayer()
    {
        var go = Factory.Prim(PrimitiveType.Sphere, "Player", new Vector3(0f, 1f, 0f), Vector3.one, playerColor, null, 0.4f);
        var rb = go.AddComponent<Rigidbody>();
        rb.mass = 1f;
        rb.SetDrag(0.4f, 0.5f);
        rb.interpolation = RigidbodyInterpolation.Interpolate;
        rb.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic;
        player = go.AddComponent<PlayerController>();
        player.cameraRef = cam.transform;
        player.controlsEnabled = false;
        playerRenderer = go.GetComponent<Renderer>();
        camFollow.target = go.transform;
    }

    // ---------- Déroulement de la partie ----------

    void StartGame()
    {
        ClearDynamic();
        score = 0;
        lives = StartLives;
        wave = 0;
        player.ResetAt(new Vector3(0f, 1f, 0f));
        player.controlsEnabled = true;
        state = State.Playing;
        NextWave();
    }

    void ClearDynamic()
    {
        StopAllCoroutines();
        if (dynamicRoot != null) Destroy(dynamicRoot.gameObject);
        dynamicRoot = new GameObject("Dynamic").transform;
        orbs.Clear();
        enemies.Clear();
    }

    void NextWave()
    {
        wave++;
        ShowBanner("VAGUE " + wave, 2f);

        int orbCount = 6 + wave * 2;
        for (int i = 0; i < orbCount; i++) SpawnOrb(FindFreeSpot(), false);
        foreach (var top in platformTops) SpawnOrb(top + Vector3.up * 0.8f, true);

        int enemyCount = Mathf.Min(wave, 8);
        for (int i = 0; i < enemyCount; i++) SpawnEnemy();
    }

    Vector3 FindFreeSpot()
    {
        for (int i = 0; i < 40; i++)
        {
            var p = RandomArenaPoint(3f) + Vector3.up * 0.8f;
            if (!Physics.CheckSphere(p, 0.7f, ~0, QueryTriggerInteraction.Ignore)) return p;
        }
        return RandomArenaPoint(3f) + Vector3.up * 0.8f;
    }

    void SpawnOrb(Vector3 pos, bool golden)
    {
        Color c = golden ? new Color(1f, 0.8f, 0.1f) : new Color(0.2f, 0.9f, 1f);
        float s = golden ? 0.7f : 0.5f;
        var go = Factory.Prim(PrimitiveType.Cube, golden ? "GoldenOrb" : "Orb", pos, Vector3.one * s, c, dynamicRoot, 2.5f);
        go.GetComponent<Collider>().isTrigger = true;
        var orb = go.AddComponent<Orb>();
        orb.golden = golden;
        orb.value = golden ? 50 : 10;
        orbs.Add(orb);
    }

    void SpawnEnemy()
    {
        // Les ennemis apparaissent loin du joueur.
        Vector3 pos = Vector3.zero;
        for (int i = 0; i < 30; i++)
        {
            pos = FindFreeSpot();
            if (Vector3.Distance(pos, player.transform.position) > 10f) break;
        }
        pos.y = 3f;

        var go = Factory.Prim(PrimitiveType.Cube, "Enemy", pos, Vector3.one * 1.1f, new Color(1f, 0.15f, 0.2f), dynamicRoot, 0.8f);
        var rb = go.AddComponent<Rigidbody>();
        rb.mass = 1.2f;
        rb.SetDrag(0.5f, 2f);
        rb.collisionDetectionMode = CollisionDetectionMode.Continuous;
        var e = go.AddComponent<Enemy>();
        e.target = player.transform;
        e.maxSpeed = 4.5f + wave * 0.5f;
        e.force = 14f + wave;
        e.Stun(1f);
        enemies.Add(e);
        Debris.Burst(pos, Color.red, 8, 4f);
    }

    IEnumerator RespawnEnemyLater(float delay)
    {
        yield return new WaitForSeconds(delay);
        if (state == State.Playing) SpawnEnemy();
    }

    // ---------- Événements ----------

    public void CollectOrb(Orb orb)
    {
        if (state != State.Playing || !orbs.Remove(orb)) return;
        score += orb.value;
        Debris.Burst(orb.transform.position, orb.golden ? Color.yellow : Color.cyan, orb.golden ? 18 : 10, 5f);
        Destroy(orb.gameObject);

        if (orbs.Count == 0)
        {
            int bonus = 100 * wave;
            score += bonus;
            ShowBanner("VAGUE " + wave + " TERMINÉE !  +" + bonus, 2f);
            StartCoroutine(NextWaveLater());
        }
    }

    IEnumerator NextWaveLater()
    {
        yield return new WaitForSeconds(2f);
        if (state == State.Playing) NextWave();
    }

    public void OnPlayerHitEnemy(PlayerController p, Enemy e)
    {
        if (state != State.Playing) return;
        Vector3 away = e.transform.position - p.transform.position;
        away.y = 0f;
        away.Normalize();

        if (p.IsDashing)
        {
            // Dash réussi : le cube est projeté au loin.
            var erb = e.GetComponent<Rigidbody>();
            erb.AddForce(away * 22f + Vector3.up * 5f, ForceMode.Impulse);
            e.Stun(1.5f);
            score += 5;
            camFollow.Shake(0.25f);
            Debris.Burst(e.transform.position, new Color(1f, 0.5f, 0.2f), 10, 6f);
        }
        else if (Time.time >= invulnerableUntil)
        {
            p.GetComponent<Rigidbody>().AddForce(-away * 10f + Vector3.up * 3f, ForceMode.Impulse);
            e.Stun(0.8f);
            LoseLife();
        }
    }

    public void OnEnemyFell(Enemy e)
    {
        enemies.Remove(e);
        Destroy(e.gameObject);
        if (state != State.Playing) return;
        int pts = 50 * wave;
        score += pts;
        ShowBanner("CUBE ÉJECTÉ !  +" + pts, 1.2f);
        StartCoroutine(RespawnEnemyLater(3f));
    }

    void LoseLife()
    {
        lives--;
        invulnerableUntil = Time.time + 1.5f;
        camFollow.Shake(0.5f);
        Debris.Burst(player.transform.position, playerColor, 14, 6f);
        if (lives <= 0) GameOver();
    }

    void GameOver()
    {
        state = State.GameOver;
        player.controlsEnabled = false;
        if (score > highScore)
        {
            highScore = score;
            PlayerPrefs.SetInt("OrbRush_HighScore", highScore);
            PlayerPrefs.Save();
        }
    }

    void ShowBanner(string text, float duration)
    {
        banner = text;
        bannerUntil = Time.time + duration;
    }

    // ---------- Boucle ----------

    void Update()
    {
        bool confirm = Input.GetKeyDown(KeyCode.Return) || Input.GetKeyDown(KeyCode.KeypadEnter);

        switch (state)
        {
            case State.Menu:
            case State.GameOver:
                if (confirm || (state == State.Menu && Input.GetKeyDown(KeyCode.Space))) StartGame();
                if (Input.GetKeyDown(KeyCode.R))
                {
                    ClearDynamic();
                    BuildArena(Random.Range(1, 99999));
                    player.ResetAt(new Vector3(0f, 1f, 0f));
                }
                break;

            case State.Playing:
                if (player.transform.position.y < KillY)
                {
                    player.ResetAt(new Vector3(0f, 3f, 0f));
                    LoseLife();
                }
                if (Input.GetKeyDown(KeyCode.Escape))
                {
                    state = State.Menu;
                    player.controlsEnabled = false;
                    ClearDynamic();
                }
                break;
        }

        // Clignotement pendant l'invulnérabilité.
        bool blink = state == State.Playing && Time.time < invulnerableUntil;
        playerRenderer.enabled = !blink || Mathf.Repeat(Time.time * 12f, 1f) > 0.4f;
    }

    // ---------- Interface ----------

    GUIStyle big, mid, small;

    void InitStyles()
    {
        if (big != null) return;
        big = new GUIStyle(GUI.skin.label) { fontSize = 64, fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
        mid = new GUIStyle(big) { fontSize = 30 };
        small = new GUIStyle(GUI.skin.label) { fontSize = 20, fontStyle = FontStyle.Bold };
    }

    void Shadowed(Rect r, string text, GUIStyle style, Color color)
    {
        var old = GUI.color;
        GUI.color = new Color(0f, 0f, 0f, 0.7f);
        GUI.Label(new Rect(r.x + 3, r.y + 3, r.width, r.height), text, style);
        GUI.color = color;
        GUI.Label(r, text, style);
        GUI.color = old;
    }

    void OnGUI()
    {
        InitStyles();
        float w = Screen.width, h = Screen.height;

        if (state == State.Menu)
        {
            Shadowed(new Rect(0, h * 0.18f, w, 90), "ORB RUSH", big, new Color(0.3f, 0.95f, 1f));
            Shadowed(new Rect(0, h * 0.32f, w, 40), "Ramasse les orbes. Éjecte les cubes. Ne tombe pas.", mid, Color.white);
            Shadowed(new Rect(0, h * 0.48f, w, 200),
                "WASD / Flèches : rouler\nEspace : sauter\nShift / Clic gauche : dash (éjecte les cubes)\nClic droit + souris ou Q / E : tourner la caméra\nR : nouvelle arène au pif",
                new GUIStyle(mid) { fontSize = 20 }, new Color(0.85f, 0.85f, 0.95f));
            float pulse = 0.6f + 0.4f * Mathf.Sin(Time.time * 4f);
            Shadowed(new Rect(0, h * 0.78f, w, 40), "Appuie sur ENTRÉE pour jouer", mid, new Color(1f, 0.85f, 0.2f, pulse));
            Shadowed(new Rect(16, h - 36, w, 30), "Record : " + highScore + "    Arène #" + seed, small, Color.white);
            return;
        }

        // HUD
        Shadowed(new Rect(16, 12, 400, 30), "Score : " + score, small, Color.white);
        Shadowed(new Rect(16, 40, 400, 30), "Vague : " + wave, small, Color.white);
        Shadowed(new Rect(16, 68, 400, 30), "Vies : " + Mathf.Max(lives, 0), small, new Color(1f, 0.4f, 0.45f));
        Shadowed(new Rect(16, 96, 400, 30), "Orbes restantes : " + orbs.Count, small, new Color(0.4f, 0.95f, 1f));
        Shadowed(new Rect(w - 216, 12, 200, 30), "Record : " + highScore, small, Color.white);

        // Jauge de dash
        float charge = player.DashCharge;
        var barRect = new Rect(w / 2 - 100, h - 40, 200, 14);
        GUI.color = new Color(0f, 0f, 0f, 0.6f);
        GUI.DrawTexture(barRect, Texture2D.whiteTexture);
        GUI.color = charge >= 1f ? new Color(1f, 0.85f, 0.2f) : new Color(0.6f, 0.6f, 0.6f);
        GUI.DrawTexture(new Rect(barRect.x, barRect.y, barRect.width * charge, barRect.height), Texture2D.whiteTexture);
        GUI.color = Color.white;
        Shadowed(new Rect(0, h - 66, w, 24), "DASH", new GUIStyle(small) { alignment = TextAnchor.MiddleCenter }, Color.white);

        if (state == State.Playing && Time.time < bannerUntil)
            Shadowed(new Rect(0, h * 0.2f, w, 60), banner, mid, new Color(1f, 0.9f, 0.3f));

        if (state == State.GameOver)
        {
            GUI.color = new Color(0f, 0f, 0f, 0.5f);
            GUI.DrawTexture(new Rect(0, 0, w, h), Texture2D.whiteTexture);
            GUI.color = Color.white;
            Shadowed(new Rect(0, h * 0.25f, w, 90), "GAME OVER", big, new Color(1f, 0.3f, 0.35f));
            Shadowed(new Rect(0, h * 0.42f, w, 40), "Score : " + score + "   (vague " + wave + ")", mid, Color.white);
            bool record = score >= highScore && score > 0;
            Shadowed(new Rect(0, h * 0.50f, w, 40), record ? "NOUVEAU RECORD !" : "Record : " + highScore, mid, new Color(1f, 0.85f, 0.2f));
            Shadowed(new Rect(0, h * 0.65f, w, 40), "ENTRÉE : rejouer     R : nouvelle arène", mid, Color.white);
        }
    }
}
