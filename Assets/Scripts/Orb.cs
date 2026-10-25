using UnityEngine;

// Orbe à ramasser : tourne, flotte, et rapporte des points.
public class Orb : MonoBehaviour
{
    public int value = 10;
    public bool golden;

    Vector3 basePos;
    float phase;

    void Start()
    {
        basePos = transform.position;
        phase = Random.value * 10f;
    }

    void Update()
    {
        transform.rotation = Quaternion.Euler(45f, (Time.time * 90f * (golden ? 2f : 1f) + phase * 36f) % 360f, 45f);
        transform.position = basePos + Vector3.up * Mathf.Sin(Time.time * 2.5f + phase) * 0.2f;
    }

    void OnTriggerEnter(Collider other)
    {
        if (other.GetComponent<PlayerController>() != null && GameManager.I != null)
            GameManager.I.CollectOrb(this);
    }
}
