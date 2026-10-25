using UnityEngine;

// Petits éclats décoratifs qui s'envolent et rétrécissent.
public class Debris : MonoBehaviour
{
    public Vector3 velocity;
    public float life = 0.7f;

    float age;
    Vector3 startScale;

    void Start() => startScale = transform.localScale;

    void Update()
    {
        age += Time.deltaTime;
        velocity += Physics.gravity * 0.5f * Time.deltaTime;
        transform.position += velocity * Time.deltaTime;
        transform.Rotate(360f * Time.deltaTime, 200f * Time.deltaTime, 0f);
        transform.localScale = startScale * (1f - age / life);
        if (age >= life) Destroy(gameObject);
    }

    public static void Burst(Vector3 pos, Color color, int count, float speed)
    {
        var mat = Factory.Mat(color, 2f);
        for (int i = 0; i < count; i++)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            Factory.RemoveCollider(go);
            go.transform.position = pos;
            go.transform.localScale = Vector3.one * Random.Range(0.1f, 0.25f);
            go.GetComponent<Renderer>().sharedMaterial = mat;
            var d = go.AddComponent<Debris>();
            d.velocity = (Random.onUnitSphere + Vector3.up) * speed * Random.Range(0.5f, 1f);
        }
    }
}
