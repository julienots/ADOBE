using UnityEngine;

// Lance le jeu automatiquement dans n'importe quelle scène : aucun réglage manuel requis.
public static class GameBootstrap
{
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void Init()
    {
        if (Object.FindFirstObjectByType<GameManager>() != null) return;
        new GameObject("GameManager").AddComponent<GameManager>();
    }
}
