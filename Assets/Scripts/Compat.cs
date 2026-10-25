using UnityEngine;

// Petites aides pour rester compatible Unity 2022 LTS et Unity 6.
public static class Compat
{
    public static Vector3 GetVelocity(this Rigidbody rb)
    {
#if UNITY_6000_0_OR_NEWER
        return rb.linearVelocity;
#else
        return rb.velocity;
#endif
    }

    public static void SetVelocity(this Rigidbody rb, Vector3 v)
    {
#if UNITY_6000_0_OR_NEWER
        rb.linearVelocity = v;
#else
        rb.velocity = v;
#endif
    }

    public static void SetDrag(this Rigidbody rb, float drag, float angularDrag)
    {
#if UNITY_6000_0_OR_NEWER
        rb.linearDamping = drag;
        rb.angularDamping = angularDrag;
#else
        rb.drag = drag;
        rb.angularDrag = angularDrag;
#endif
    }
}

// Fabrique d'objets et de matériaux colorés, quel que soit le pipeline de rendu (Built-in ou URP).
public static class Factory
{
    static Material baseMaterial;

    public static Material Mat(Color color, float emission = 0f)
    {
        if (baseMaterial == null)
        {
            var tmp = GameObject.CreatePrimitive(PrimitiveType.Cube);
            baseMaterial = tmp.GetComponent<Renderer>().sharedMaterial;
            Object.DestroyImmediate(tmp);
        }
        var m = new Material(baseMaterial) { color = color };
        if (emission > 0f)
        {
            m.EnableKeyword("_EMISSION");
            m.SetColor("_EmissionColor", color * emission);
        }
        return m;
    }

    public static GameObject Prim(PrimitiveType type, string name, Vector3 pos, Vector3 scale,
                                  Color color, Transform parent = null, float emission = 0f)
    {
        var go = GameObject.CreatePrimitive(type);
        go.name = name;
        go.transform.SetParent(parent, false);
        go.transform.position = pos;
        go.transform.localScale = scale;
        go.GetComponent<Renderer>().sharedMaterial = Mat(color, emission);
        return go;
    }

    public static void RemoveCollider(GameObject go)
    {
        var c = go.GetComponent<Collider>();
        if (c != null) Object.DestroyImmediate(c);
    }
}
