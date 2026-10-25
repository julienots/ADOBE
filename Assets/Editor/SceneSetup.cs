using UnityEditor;
using UnityEngine;

// Réglages du projet appliqués à chaque chargement de l'éditeur (y compris en ligne de commande / CI) :
// nom du jeu, identifiant Android, orientation paysage, et la scène Main dans le build.
[InitializeOnLoad]
static class SceneSetup
{
    const string ScenePath = "Assets/Scenes/Main.unity";
    const string AppId = "com.orbrush.game";

    static SceneSetup()
    {
        if (PlayerSettings.productName != "Orb Rush") PlayerSettings.productName = "Orb Rush";
        if (PlayerSettings.companyName != "OrbRush") PlayerSettings.companyName = "OrbRush";
        if (PlayerSettings.GetApplicationIdentifier(BuildTargetGroup.Android) != AppId)
            PlayerSettings.SetApplicationIdentifier(BuildTargetGroup.Android, AppId);
        if (PlayerSettings.defaultInterfaceOrientation != UIOrientation.LandscapeLeft)
            PlayerSettings.defaultInterfaceOrientation = UIOrientation.LandscapeLeft;

        // IL2CPP + ARM64 : obligatoire pour les téléphones récents qui ne gèrent plus le 32 bits.
        if (PlayerSettings.GetScriptingBackend(BuildTargetGroup.Android) != ScriptingImplementation.IL2CPP)
            PlayerSettings.SetScriptingBackend(BuildTargetGroup.Android, ScriptingImplementation.IL2CPP);
        var arch = AndroidArchitecture.ARMv7 | AndroidArchitecture.ARM64;
        if (PlayerSettings.Android.targetArchitectures != arch)
            PlayerSettings.Android.targetArchitectures = arch;

        if (EditorBuildSettings.scenes.Length == 0)
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
    }
}
