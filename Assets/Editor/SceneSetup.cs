using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;

// À la première ouverture du projet : crée Assets/Scenes/Main.unity et l'ajoute au build.
// Le jeu se construit tout seul au lancement (voir GameBootstrap), la scène peut donc rester vide.
[InitializeOnLoad]
static class SceneSetup
{
    const string ScenePath = "Assets/Scenes/Main.unity";

    static SceneSetup() => EditorApplication.delayCall += Ensure;

    static void Ensure()
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode) return;

        if (!File.Exists(ScenePath))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            EditorSceneManager.SaveScene(scene, ScenePath);
        }

        if (EditorBuildSettings.scenes.Length == 0)
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
    }
}
