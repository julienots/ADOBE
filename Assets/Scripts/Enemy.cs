using UnityEngine;

// Cube rouge qui fonce sur le joueur. Pousse-le dans le vide avec un dash !
[RequireComponent(typeof(Rigidbody))]
public class Enemy : MonoBehaviour
{
    public Transform target;
    public float force = 16f;
    public float maxSpeed = 6f;

    Rigidbody rb;
    bool fallen;
    float stunnedUntil;

    void Awake() => rb = GetComponent<Rigidbody>();

    public void Stun(float seconds) => stunnedUntil = Time.time + seconds;

    void FixedUpdate()
    {
        if (target == null || Time.time < stunnedUntil) return;

        Vector3 to = target.position - transform.position;
        to.y = 0f;
        Vector3 vel = rb.GetVelocity();
        Vector3 flat = new Vector3(vel.x, 0f, vel.z);
        Vector3 dir = to.normalized;
        if (Vector3.Dot(flat, dir) < maxSpeed)
            rb.AddForce(dir * force, ForceMode.Acceleration);
    }

    void Update()
    {
        if (!fallen && transform.position.y < -8f)
        {
            fallen = true;
            if (GameManager.I != null) GameManager.I.OnEnemyFell(this);
        }
    }

    void OnCollisionEnter(Collision c)
    {
        var p = c.collider.GetComponent<PlayerController>();
        if (p != null && GameManager.I != null) GameManager.I.OnPlayerHitEnemy(p, this);
    }
}
